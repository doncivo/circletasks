import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, RoutineId } from '../types';
import { SYNC_TABLE_ORDER, epochId, type DeviceAck, type PublishedDeviceState } from './format';
import { canPublish, folderEpoch, mustCarry, nextEpoch, openingCover, ownBounds, restoreOptions } from './epoch';
import { expectedNaturalId, holidayId, isNaturalId, routineLogId } from './naturalIds';
import { focusSessionsToClose, routinePausedFrom } from './repairs';
import { FIXED_SPACE_IDS, SHARED_SETTING_KEYS, SYNC_TABLES, childRelations, isPurgeable, isValidRowId, isValidValue, settingKeyScope, syncColumn, syncTable, tableRank } from './syncTables';

/** Catalogue, identifiants déterministes, époques et règle 1, réparations (ADR 0011, sections 3.3, 8, 9 ; Y-02 critères 4, 8, 9, 13 à 15). */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const h = (ms: number, dev: string = A): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const E1 = epochId(1, A);
const E2 = epochId(2, B);

describe('catalogue (syncTables.ts)', () => {
  it('tables dans l’ordre topologique, colonnes locales jamais publiées', () => {
    expect(SYNC_TABLES.map((t) => t.name)).toEqual([...SYNC_TABLE_ORDER]);
    expect(syncColumn('task', 'discarded')).toBeUndefined();
    expect(syncColumn('routine', 'paused')).toBeUndefined();
    expect(syncColumn('calendar_account', 'token_ref')).toBeUndefined();
    expect(syncColumn('calendar_account', 'username')).toBeUndefined();
    expect(syncColumn('task', 'hlc')).toBeUndefined();
    expect(syncTable('Task')).toBeUndefined();
    expect(syncTable('search_index')).toBeUndefined();
    expect(syncTable('external_event')).toBeUndefined();
    expect(tableRank('space')).toBe(0);
    expect(tableRank('inconnue')).toBe(SYNC_TABLE_ORDER.length);
    expect(childRelations('project').map((r) => `${r.table.name}.${r.column}`)).toEqual(['task.project_id']);
  });

  it('types et longueurs vérifiés', () => {
    const col = (t: string, c: string) => syncColumn(t, c) ?? (() => { throw new Error(c); })();
    expect(isValidValue(col('task', 'status'), 'done')).toBe(true);
    expect(isValidValue(col('task', 'status'), 'peut-être')).toBe(false);
    expect(isValidValue(col('task', 'title'), null)).toBe(false);
    expect(isValidValue(col('task', 'date'), '2026-02-30')).toBe(false);
    expect(isValidValue(col('task', 'time'), '24:00')).toBe(false);
    expect(isValidValue(col('task', 'someday'), 2)).toBe(false);
    expect(isValidValue(col('task', 'series_index'), -1)).toBe(true);
    expect(isValidValue(col('reminder', 'offset_min'), 7)).toBe(false);
    expect(isValidValue(col('space', 'quiet_hours'), '{nope')).toBe(false);
    expect(isValidValue(col('task', 'deleted_at'), '2026-10-05T08:00:00.000Z')).toBe(true);
    expect(isValidValue(col('task', 'note'), 'x'.repeat(200 * 1024 + 1))).toBe(false);
    expect(isValidValue(col('task', 'sort_order'), Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('identifiants : UUID, naturel, clé de réglage ; réglages partagés seulement', () => {
    const task = syncTable('task');
    const log = syncTable('routine_log');
    const settings = syncTable('settings');
    if (!task || !log || !settings) throw new Error('catalogue');
    expect(isValidRowId(task, A)).toBe(true);
    expect(isValidRowId(task, 'rlog|x')).toBe(false);
    expect(isValidRowId(log, routineLogId(A as unknown as RoutineId, '2026-10-05' as LocalDate))).toBe(true);
    expect(isValidRowId(settings, 'general.locale')).toBe(true);
    expect(isValidRowId(settings, '__proto__')).toBe(false);
    expect(settingKeyScope('general.locale')).toBe('shared');
    expect(settingKeyScope('device.id')).toBe('local');
    expect(settingKeyScope('toString')).toBe('unknown');
    expect(SHARED_SETTING_KEYS).not.toContain('device.id');
    expect(SHARED_SETTING_KEYS).toContain('holidays.countries');
  });

  it('espaces fixes et réglages jamais purgés (Y-09 critère 5)', () => {
    for (const id of FIXED_SPACE_IDS) expect(isPurgeable('space', id)).toBe(false);
    expect(isPurgeable('space', A)).toBe(true);
    expect(isPurgeable('settings', 'general.locale')).toBe(false);
    expect(isPurgeable('external_event', A)).toBe(false);
  });
});

describe('identifiants déterministes (Y-02 critère 9)', () => {
  it('rlog|<routine>|<date> et holiday|<pays>|<année>|<clé>', () => {
    const r = '3b241101-e2bb-4255-8caf-4136c566a962' as RoutineId;
    expect(routineLogId(r, '2026-10-05' as LocalDate)).toBe(`rlog|${r}|2026-10-05`);
    expect(holidayId('TN', 2027, 'eidAlFitr')).toBe('holiday|TN|2027|eidAlFitr');
    expect(isNaturalId('routine_log', `rlog|${r}|2026-10-05`)).toBe(true);
    expect(isNaturalId('routine_log', `rlog|${r}|2026-13-05`)).toBe(false);
    expect(isNaturalId('holiday', 'holiday|DE|2027|x')).toBe(false);
    expect(expectedNaturalId('routine_log', new Map([['routine_id', r], ['date', '2026-10-05']]))).toBe(`rlog|${r}|2026-10-05`);
    expect(expectedNaturalId('holiday', new Map<string, unknown>([['country', 'FR'], ['year', 2026], ['key', 'noel']]))).toBe('holiday|FR|2026|noel');
    expect(expectedNaturalId('holiday', new Map())).toBeNull();
  });
});

const ack = (segment: number, record: number, hlc: Hlc | null, stateSeq: number, epoch = E1): DeviceAck => ({ epoch, segment, record, hlc, stateSeq });
const state = (epoch = E1, snapshot = true, stateSeq = 1): PublishedDeviceState => ({
  deviceId: A,
  platform: 'windows',
  appVersion: '1',
  sm: 1,
  sv: 17,
  epoch,
  stateSeq,
  head: ack(2, 3, h(30), stateSeq, epoch),
  acks: new Map<DeviceId, DeviceAck>(),
  snapshot: snapshot ? { seq: 1, endHlc: h(1) } : null,
  purgeHorizon: null,
  lastSyncHlc: h(31),
  forgotten: [],
  reset: null,
});

describe('époques et règle 1 (Y-02 critères 13 à 15)', () => {
  it('époque du dossier : la plus grande dotée d’un instantané', () => {
    expect(folderEpoch([])).toBeNull();
    expect(folderEpoch([state(E1), state(E2, false)])).toBe(E1);
    expect(folderEpoch([state(E1), state(E2)])).toBe(E2);
    expect(nextEpoch(E2, A)).toBe(epochId(3, A));
    expect(nextEpoch(null, A)).toBe(E1);
  });

  it('bornes : maxima de la base, de l’état publié et des accusés ; stateSeq toutes époques, tête de l’époque courante seulement', () => {
    const bounds = ownBounds({
      epoch: E1,
      local: { epoch: E1, stateSeq: 2, head: ack(1, 5, h(10), 2) },
      published: state(E1, true, 4),
      acksOnSelf: [ack(3, 1, h(40), 9), ack(9, 9, h(99), 12, E2)],
      listedMaxSegment: 5,
    });
    expect(bounds.nextStateSeq).toBe(13);
    expect(bounds.head).toEqual({ segment: 3, record: 1 });
    expect(bounds.headHlc).toBe(h(40));
    expect(bounds.maxSegment).toBe(5);
  });

  it('publication : état authentifié, borne d’un accusé, ou jamais rien publié', () => {
    expect(canPublish({ ownStateOk: true, acksOnSelf: 0, listedFiles: 3, localStateSeq: 2 })).toBe(true);
    expect(canPublish({ ownStateOk: false, acksOnSelf: 1, listedFiles: 3, localStateSeq: 2 })).toBe(true);
    expect(canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: 0, localStateSeq: 0 })).toBe(true);
    expect(canPublish({ ownStateOk: false, acksOnSelf: 0, listedFiles: 2, localStateSeq: 0 })).toBe(false);
  });

  it('règle 4 : sauvegarde antérieure au plus grand purgeHorizon : seulement « Appliquer partout »', () => {
    const taken = '2026-10-05T08:00:00.000Z' as IsoDateTime;
    const ms = Date.parse(taken);
    expect(restoreOptions(taken, [null])).toEqual(['apply-everywhere', 'keep-synced']);
    expect(restoreOptions(taken, [h(ms - 1)])).toEqual(['apply-everywhere', 'keep-synced']);
    expect(restoreOptions(taken, [null, h(ms + 1)])).toEqual(['apply-everywhere']);
  });

  it('covers[B] après restauration : maximum de la base restaurée et du dernier état publié ; report : champs de soi au-delà', () => {
    expect(openingCover(ack(1, 2, h(5), 1), ack(2, 0, h(9), 3))).toEqual(ack(2, 0, h(9), 3));
    expect(openingCover(null, ack(2, 0, h(9), 3))).toEqual(ack(2, 0, h(9), 3));
    expect(openingCover(ack(1, 0, h(1), 1, E2), ack(9, 0, h(9), 3))?.epoch).toBe(E2);
    expect(mustCarry(h(10, B), B, ack(1, 1, h(9, B), 1))).toBe(true);
    expect(mustCarry(h(9, B), B, ack(1, 1, h(9, B), 1))).toBe(false);
    expect(mustCarry(h(10, A), B, null)).toBe(false);
    expect(mustCarry(h(1, B), B, null)).toBe(true);
  });
});

describe('réparations (Y-02 critère 8)', () => {
  it('routine.paused = une période ouverte et non supprimée', () => {
    expect(routinePausedFrom([])).toBe(false);
    expect(routinePausedFrom([{ toDate: null, deletedAt: null }])).toBe(true);
    expect(routinePausedFrom([{ toDate: null, deletedAt: 'x' }, { toDate: '2026-10-01', deletedAt: null }])).toBe(false);
  });

  it('Focus : toutes sauf la plus récente closes à son heure de début (valeur déterministe)', () => {
    expect(focusSessionsToClose([{ id: 'a', startedAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, hlc: h(1) }])).toEqual([]);
    const open = [
      { id: 'a', startedAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, hlc: h(1) },
      { id: 'b', startedAt: '2026-10-05T09:00:00.000Z' as IsoDateTime, hlc: h(2) },
      { id: 'c', startedAt: '2026-10-05T09:00:00.000Z' as IsoDateTime, hlc: h(3) },
    ];
    expect(focusSessionsToClose(open)).toEqual([
      { id: 'b', endedAt: '2026-10-05T09:00:00.000Z' },
      { id: 'a', endedAt: '2026-10-05T09:00:00.000Z' },
    ]);
    expect(focusSessionsToClose([...open].reverse())).toEqual(focusSessionsToClose(open));
  });
});

describe('échéance d’un rappel (seconde revue Y2, rappels)', () => {
  it('fire_at est une date et heure locales flottantes (LocalDateTime), pas un instant UTC : la forme écrite par l’app est acceptée', () => {
    const col = syncColumn('reminder', 'fire_at');
    expect(col?.type).toBe('localdatetime');
    expect(col && isValidValue(col, '2026-10-05T09:00')).toBe(true);
    expect(col && isValidValue(col, '2026-10-05T09:00:00.000Z')).toBe(false);
    expect(col && isValidValue(col, '2026-13-05T09:00')).toBe(false);
    expect(col && isValidValue(col, 42)).toBe(false);
  });
});
