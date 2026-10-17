import { afterEach, describe, expect, it } from 'vitest';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-04, partie B (revue, B1) : restaurer la copie faite par un AUTRE appareil. Le Rust (`carry_device_identity`, testé dans
 * `src-tauri/tests/desktop/restore_identity*.rs`) écrit dans la base préparée, avant l'échange : l'identité de l'appareil (`device.id`,
 * ligne `is_self`), l'état de publication de l'appareil (clés d'identité de `sync_meta`, remplacées par celles de la base en place) et la
 * file d'envoi de l'autre appareil, ré-signée au nom de l'appareil courant. `carryIdentity` ci-dessous est la jumelle de ce contrat sur les
 * lignes de la copie ; le test joue ensuite les deux choix avec le vrai moteur : identité conservée, aucun code d'erreur de cycle, écriture
 * non publiée de l'autre appareil publiée par l'appareil courant et reçue par un troisième.
 * Preuve de détection : sans `carryIdentity` (`corrected = false`), le test échoue (`restart-required`, écriture jamais publiée).
 */

const CURRENT = '7d0b7d0b-7d0b-4d0b-8d0b-7d0b7d0b7d0b';
const OTHER = '56d456d4-56d4-456d-856d-56d456d456d4';
const PHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type RestoreOption = 'apply-everywhere' | 'keep-synced';
type Row = Record<string, string | number | null>;
type Copy = Map<string, Row[]>;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Clés de `sync_meta` qui décrivent la publication de l'appareil (même liste que `IDENTITY_META_KEYS` de `backup.rs`). */
const IDENTITY_META = ['epoch', 'stateSeq', 'head', 'inflight', 'lastState', 'snapshot', 'segments', 'epochSwitch', 'epochCarry', 'resume', 'join', 'forgetPublish', 'forgetDeletions', 'ownStateHlcs', 'orphanEpoch', 'orphanTraces', 'orphanTraceHit', 'orphanTraceAck'];

async function backupOf(device: SimDevice): Promise<Copy> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy: Copy = new Map();
  for (const { name } of tables) copy.set(name, await device.driver.select<Row>(`SELECT * FROM ${name}`));
  return copy;
}

const signedBy = (hlc: unknown, id: string): boolean => typeof hlc === 'string' && hlc.slice(21) === id;
const restamp = (hlc: string, id: string): string => `${hlc.slice(0, 21)}${id}`;

/** Jumelle TypeScript de `carry_device_identity` sur une copie d'un autre appareil (`other`), pour la base en place `live`. */
function carryIdentity(other: Copy, live: Copy, current: string, old: string): Copy {
  const out: Copy = new Map([...other].map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  const table = (name: string): Row[] => out.get(name) ?? [];
  // device.id et sync_state.
  const setting = table('settings').find((r) => r['key'] === 'device.id');
  if (setting) setting['value'] = JSON.stringify(current);
  for (const row of table('sync_state')) if (row['is_self'] === 1 && row['device_id'] !== current) row['is_self'] = 0;
  const known = table('sync_state').find((r) => r['device_id'] === current);
  if (known) Object.assign(known, { is_self: 1, epoch: null, cursor_segment: 0, cursor_record: 0, ack_hlc: null, status: 'active' });
  else table('sync_state').push({ device_id: current, is_self: 1, platform: 'windows', status: 'active' });
  // File d'envoi ré-signée (tâches : clé `id`).
  for (const entry of table('sync_outbox').filter((e) => e['table_name'] === 'task')) {
    const row = table('task').find((r) => r['id'] === entry['row_id']);
    if (!row) continue;
    const clocks = table('sync_field_clock').filter((c) => c['table_name'] === 'task' && c['row_id'] === entry['row_id']);
    const whole = entry['field'] === '*' || entry['field'] === '+';
    for (const clock of clocks) if ((whole || clock['field'] === entry['field']) && signedBy(clock['hlc'], old)) clock['hlc'] = restamp(String(clock['hlc']), current);
    if (signedBy(row['hlc'], old)) {
      if (!whole && !clocks.some((c) => c['field'] === '*')) table('sync_field_clock').push({ table_name: 'task', row_id: String(entry['row_id']), field: '*', hlc: String(row['hlc']), base_hlc: null });
      row['hlc'] = restamp(String(row['hlc']), current);
      row['device_id'] = current;
    }
  }
  // État de publication : celui de la base en place.
  const meta = table('sync_meta').filter((r) => !IDENTITY_META.includes(String(r['key'])));
  meta.push(...(live.get('sync_meta') ?? []).filter((r) => IDENTITY_META.includes(String(r['key']))).map((r) => ({ ...r })));
  out.set('sync_meta', meta);
  return out;
}

async function restore(device: SimDevice, copy: Copy): Promise<void> {
  await device.driver.execute('PRAGMA foreign_keys = OFF');
  await device.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const [table, rows] of copy) {
      if (table === 'sync_guard' || table === 'schema_migrations') continue;
      await tx.execute(`DELETE FROM ${table}`);
      for (const row of rows) {
        const cols = Object.keys(row);
        await tx.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
      }
    }
    await tx.execute('DELETE FROM sync_guard');
  });
  await device.driver.execute('PRAGMA foreign_keys = ON');
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261016.db', backupTakenAt: '2026-10-16T08:00:00.000Z' as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: 17 };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
}

/** Trois appareils d'un même dossier : `a` (courant), `o` (l'autre, dont on restaure la copie), `p` (le troisième, qui reçoit). */
async function group(): Promise<{ a: SimDevice; o: SimDevice; p: SimDevice }> {
  const o = await createSimDevice(OTHER, { name: 'Ancien PC' });
  const a = await createSimDevice(CURRENT, { name: 'PC', clock: o.clock });
  const p = await createSimDevice(PHONE, { name: 'iPhone', clock: o.clock });
  devices = [a, o, p];
  await setupFirst(o);
  await o.cycle();
  await pair(o, a);
  await pair(o, p);
  for (let i = 0; i < 2; i += 1) {
    syncFolders(devices);
    for (const d of devices) await d.cycle();
  }
  return { a, o, p };
}

/** Un tour de cycles avec propagation du dossier entre chaque appareil. */
async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    for (const d of list) {
      syncFolders(devices);
      await d.cycle();
    }
  }
  syncFolders(devices);
}

async function scenario(corrected: boolean, option: RestoreOption, publishAfter = false): Promise<{ a: SimDevice; p: SimDevice; unpublishedTitle: string }> {
  const { a, o, p } = await group();
  await a.createTask('A publiée');
  await settle(devices);
  await o.createTask('O publiée');
  await settle(devices);
  // L'autre appareil écrit sans publier : l'écriture est dans sa file d'envoi, sa copie la contient.
  const unpublishedTitle = 'O non publiée';
  await o.createTask(unpublishedTitle);
  const copy = await backupOf(o);
  if (publishAfter) {
    // Cas réel du 17 octobre : l’appareil courant publie APRÈS l’écriture non publiée de l’autre (sa tête dépasse le hlc d’origine).
    a.clock.advance(60_000);
    await a.createTask('A publiée après');
    await settle([a, p]);
  }
  const live = await backupOf(a);
  await restore(a, corrected ? carryIdentity(copy, live, CURRENT, OTHER) : copy);
  await a.service.chooseRestoreOption(option);
  await settle([a, p]);
  return { a, p, unpublishedTitle };
}

describe.each<[RestoreOption, boolean]>([['keep-synced', false], ['apply-everywhere', false], ['keep-synced', true], ['apply-everywhere', true]])('restauration de la copie d’un autre appareil, choix %s, l’appareil courant publie après : %s (Y-TECH-04, B1)', (option, publishAfter) => {
  it('l’appareil garde son identité, aucun cycle ne tombe en erreur, l’écriture non publiée de l’autre appareil est publiée par lui et reçue', async () => {
    const { a, p, unpublishedTitle } = await scenario(true, option, publishAfter);
    expect(await a.data.repos.settings.get('device.id')).toBe(CURRENT);
    const status = a.service.status();
    expect([status.phase, status.errorCode ?? null]).toEqual(['idle', null]);
    expect(a.logger.entries.filter((e) => e.event === 'restart-required')).toEqual([]);
    // Publié sous l’identité courante : le dossier de A reçoit ses fichiers, jamais ceux de l’autre appareil.
    expect(a.folder.fileNames(CURRENT).length).toBeGreaterThan(0);
    const reached = await p.driver.select<{ title: string }>('SELECT title FROM task WHERE title = ?', [unpublishedTitle]);
    expect(reached).toHaveLength(1);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(p));
  });
});

describe('preuve de détection : la copie d’un autre appareil telle quelle (sans la correction du Rust)', () => {
  it.each<[RestoreOption]>([['keep-synced'], ['apply-everywhere']])('choix %s : le scénario corrigé échoue sans correction', async (option) => {
    const worked = await scenario(false, option).then(
      async ({ a, p, unpublishedTitle }) => {
        const status = a.service.status();
        const reached = await p.driver.select('SELECT title FROM task WHERE title = ?', [unpublishedTitle]);
        return status.phase === 'idle' && (status.errorCode ?? null) === null && reached.length === 1 && String(await a.data.repos.settings.get('device.id')) === CURRENT;
      },
      () => false,
    );
    expect(worked).toBe(false);
  });
});
