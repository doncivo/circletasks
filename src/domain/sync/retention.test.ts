import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { epochId, type DeviceAck, type JournalRecord } from './format';
import { isTooFarAhead, recordIsAhead, recordMaxHlc } from './drift';
import { HLC_MAX_DRIFT_MS } from './limits';
import { activeReaders, canPurgeDeletion, isExpired, purgeBefore, purgeHorizon, readByAll, segmentPurgeable, UNBOUNDED, type KnownDevice } from './retention';

/**
 * Rétention et dérive (ADR 0011, sections 3.4, 4.4, 5.3 à 5.5 ; Y-09 critères 2, 6, 7 et 10). Règle validée par Ali : une trace est
 * conservée **au moins 30 jours** après la suppression **et** tant que tous les appareils actifs ne l'ont pas lue.
 */

const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-05T08:00:00.000Z');
const h = (ms: number, dev: string = SELF): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const E1 = epochId(1, SELF);
const ack = (hlc: Hlc | null, segment = 1): DeviceAck => ({ epoch: E1, segment, record: 0, hlc, stateSeq: 1 });
const device = (deviceId: DeviceId, acks: [DeviceId, DeviceAck][], status = 'active', lastSeenMs = NOW): KnownDevice => ({ deviceId, status, lastSeenHlc: h(lastSeenMs, deviceId), acks: new Map(acks) });

/** Suppression faite par SELF il y a `daysAgo` jours (deleted_at et hlc concordants). */
const deletion = (daysAgo: number): { deletedAt: IsoDateTime; deletedHlc: Hlc } => ({ deletedAt: new Date(NOW - daysAgo * DAY).toISOString() as IsoDateTime, deletedHlc: h(NOW - daysAgo * DAY) });

describe('purge des traces : les deux conditions (Y-09 D1, validée par Ali)', () => {
  it('30 jours écoulés mais un appareil actif n’a pas lu la suppression : gardée', () => {
    const d = deletion(31);
    const horizon = purgeHorizon([device(B, [[SELF, ack(h(NOW - 40 * DAY))]])], SELF, NOW);
    expect(canPurgeDeletion(d, horizon, NOW)).toBe(false);
  });

  it('tous les appareils ont lu mais 29 jours seulement : gardée', () => {
    const d = deletion(29);
    const horizon = purgeHorizon([device(B, [[SELF, ack(h(NOW))]])], SELF, NOW);
    expect(canPurgeDeletion(d, horizon, NOW)).toBe(false);
  });

  it('30 jours écoulés et lue par tous : purgée', () => {
    const d = deletion(30);
    const horizon = purgeHorizon([device(B, [[SELF, ack(h(NOW))]]), device(C, [[SELF, ack(d.deletedHlc)]])], SELF, NOW);
    expect(canPurgeDeletion(d, horizon, NOW)).toBe(true);
    expect(purgeBefore(NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('sans autre appareil actif (synchro non configurée) : seule la règle des 30 jours de T-08', () => {
    expect(purgeHorizon([], SELF, NOW)).toBe(UNBOUNDED);
    expect(canPurgeDeletion(deletion(30), UNBOUNDED, NOW)).toBe(true);
    expect(canPurgeDeletion(deletion(29), UNBOUNDED, NOW)).toBe(false);
    expect(canPurgeDeletion({ deletedAt: 'x' as IsoDateTime, deletedHlc: h(1) }, UNBOUNDED, NOW)).toBe(false);
  });

  it('suppression écrite par un autre appareil : chaque lecteur sauf l’écrivain doit l’avoir lue ; l’écrivain ne se bloque pas lui-même', () => {
    const del = { deletedAt: new Date(NOW - 40 * DAY).toISOString() as IsoDateTime, deletedHlc: h(NOW - 40 * DAY, B) };
    const unread = purgeHorizon([device(B, []), device(C, [[B, ack(null)]])], SELF, NOW);
    expect(canPurgeDeletion(del, unread, NOW)).toBe(false);
    const read = purgeHorizon([device(B, []), device(C, [[B, ack(h(NOW, B))]])], SELF, NOW);
    expect(canPurgeDeletion(del, read, NOW)).toBe(true);
  });
});

describe('appareils inactifs et sans état valide (Y-09 critère 2, section 3.4)', () => {
  it('absent depuis plus de 180 jours : expired, ne bloque plus ; moins de 180 jours : bloque', () => {
    const old = device(B, [], 'active', NOW - 181 * DAY);
    const recent = device(C, [], 'active', NOW - 179 * DAY);
    expect(isExpired(old.lastSeenHlc, NOW)).toBe(true);
    expect(isExpired(recent.lastSeenHlc, NOW)).toBe(false);
    expect(activeReaders([old, recent], SELF, NOW).map((d) => d.deviceId)).toEqual([C]);
    expect(readByAll(h(NOW - 40 * DAY), purgeHorizon([old], SELF, NOW))).toBe(true);
    expect(readByAll(h(NOW - 40 * DAY), purgeHorizon([recent], SELF, NOW))).toBe(false);
  });

  it('état invalide (foreign, corrupt, rollback) : son dernier accusé connu compte, sans rien débloquer de plus', () => {
    for (const status of ['foreign', 'corrupt', 'rollback']) {
      const stuck = device(B, [[SELF, ack(h(NOW - 35 * DAY))]], status);
      expect(readByAll(h(NOW - 36 * DAY), purgeHorizon([stuck], SELF, NOW))).toBe(true);
      expect(readByAll(h(NOW - 34 * DAY), purgeHorizon([stuck], SELF, NOW))).toBe(false);
    }
    expect(activeReaders([device(B, [], 'forgotten'), device(C, [], 'expired')], SELF, NOW)).toEqual([]);
  });
});

describe('purge de ses segments (section 5.3)', () => {
  const readers = [device(B, [[SELF, ack(h(NOW), 4)]])];
  const base = { headSegment: 5, coveredSegment: 4, readers, self: SELF, lastWriteMs: NOW - 31 * DAY, nowMs: NOW };
  it('couvert par un instantané, accusé par tous, plus de 30 jours : supprimable ; jamais la tête', () => {
    expect(segmentPurgeable(3, base)).toBe(true);
    expect(segmentPurgeable(4, base)).toBe(false);
    expect(segmentPurgeable(5, { ...base, coveredSegment: 9 })).toBe(false);
    expect(segmentPurgeable(3, { ...base, lastWriteMs: NOW - 29 * DAY })).toBe(false);
    expect(segmentPurgeable(3, { ...base, lastWriteMs: null })).toBe(false);
    expect(segmentPurgeable(3, { ...base, readers: [device(B, [[SELF, ack(h(NOW), 3)]])] })).toBe(false);
  });
});

describe('dérive d’horloge (Y-09 critère 10)', () => {
  const record = (hlc: Hlc, base: Hlc | null = null): JournalRecord => ({ k: 'ops', sv: 17, ops: [{ t: 'task', id: 'x', at: 'x' as IsoDateTime, f: new Map([['title', ['a', hlc, base]]]) }] });
  it('au-delà de nowMs() + 1 h sur l’horloge physique : refusé ; exactement 1 h : accepté', () => {
    expect(isTooFarAhead(h(NOW + HLC_MAX_DRIFT_MS, B), NOW)).toBe(false);
    expect(isTooFarAhead(h(NOW + HLC_MAX_DRIFT_MS + 1, B), NOW)).toBe(true);
    expect(recordIsAhead(record(h(NOW, B), h(NOW + 2 * HLC_MAX_DRIFT_MS, B)), NOW)).toBe(true);
    expect(recordIsAhead(record(h(NOW + 10, B)), NOW)).toBe(false);
    expect(recordMaxHlc(record(h(NOW, B)))).toBe(h(NOW, B));
    expect(recordMaxHlc({ k: 'ops', sv: 17, ops: [] })).toBeNull();
  });
});
