import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import type * as EpochSwitch from '../../../src/sync/epochSwitch';
import type { DeviceId, TaskId } from '../../../src/domain/types';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-04 partie A, critère 7 : la règle de report d'époque validée par Ali le 2026-10-17 (option B, ADR 0011 §24 point 6 et §26)
 * rejouée sur la situation réelle du 2026-10-17, avec trois auteurs dont aucun n'est oublié :
 * - `C` = ancien PC `56d4…`, auteur de la tâche « Test Pc » le 16 octobre, puis silencieux (jamais oublié) ;
 * - `B` = nouveau PC `7d0b…`, qui a lu `C` et détient « Test Pc » ;
 * - `O` = iPhone, qui n'a jamais lu « Test Pc » et restaure « Appliquer partout » une sauvegarde antérieure (il ouvre l'époque).
 * Option B : survit tout ce que `O` n'avait pas lu, sauf ses propres écritures et celles d'un appareil oublié : « Test Pc » survit.
 *
 * Preuve de détection (même fichier, jamais en production) : la règle A (« chacun ne reporte que ses propres écritures ») est injectée
 * à l'entrée du prédicat de `materialize` (`epochSwitch.ts`, closure `carries`, non exportée) : l'enveloppe de `switchEpoch` ci-dessous
 * ajoute aux appareils oubliés tous les auteurs sauf l'appareil lui-même, ce qui réduit `carries` à « auteur = soi, au-delà de
 * `covers[soi]` », c'est-à-dire exactement l'ancienne règle de l'ADR 0011 §9.1 (a). Avec elle, « Test Pc » disparaît.
 */

const C_ID = '56d4a1f0-1111-4111-8111-111111111111';
const B_ID = '7d0b2c3e-2222-4222-8222-222222222222';
const O_ID = 'ef50e1a2-3333-4333-8333-333333333333';
const ALL = [C_ID, B_ID, O_ID] as DeviceId[];

const injected = vi.hoisted(() => ({ ruleA: false, switches: [] as string[] }));

vi.mock('../../../src/sync/epochSwitch', async (importOriginal) => {
  const real = await importOriginal<typeof EpochSwitch>();
  return {
    ...real,
    switchEpoch: (...args: Parameters<typeof EpochSwitch.switchEpoch>) => {
      const [deps, target, accepted, ownState, onRemoteChanges, options = { mode: 'replace' }] = args;
      injected.switches.push(deps.deviceId);
      if (!injected.ruleA) return real.switchEpoch(deps, target, accepted, ownState, onRemoteChanges, options);
      // Règle A (test seulement) : tout autre auteur est traité comme oublié par le prédicat de report ; seul `deps.deviceId` est reporté.
      const forgotten = new Set<DeviceId>([...(options.forgotten ?? []), ...ALL.filter((id) => id !== deps.deviceId)]);
      return real.switchEpoch(deps, target, accepted, ownState, onRemoteChanges, { ...options, forgotten });
    },
  };
});

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  injected.ruleA = false;
  injected.switches = [];
});

/** Copie de la base (sauvegarde P-04 simulée), comme `epochCarryGuard.test.ts`. */
async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

/** Remplacement de la base par la copie (sous garde), marqueur de restauration posé, redémarrage. */
async function restore(device: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await device.driver.execute('PRAGMA foreign_keys = OFF');
  await device.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const [table, rows] of copy) {
      if (table === 'sync_guard' || table === 'schema_migrations') continue;
      await tx.execute(`DELETE FROM ${table}`);
      for (const row of rows as Record<string, string | number | null>[]) {
        const cols = Object.keys(row);
        await tx.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
      }
    }
    await tx.execute('DELETE FROM sync_guard');
  });
  await device.driver.execute('PRAGMA foreign_keys = ON');
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261016.db', backupTakenAt: '2026-10-16T07:00:00.000Z' as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: SCHEMA_VERSION };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
}

/** Tours de cycles entre les appareils listés seulement (l'ancien PC `C` ne revient jamais). */
async function rounds(list: readonly SimDevice[], n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    for (const d of list) {
      await d.cycle();
      syncFolders(list);
    }
  }
}

/**
 * Situation du 2026-10-17 jusqu'au choix « Appliquer partout » de `O` puis quelques tours entre `O` et `B` ; renvoie les appareils et
 * l'identifiant de « Test Pc ». Horloge déterministe partagée (`ManualClock`), aucun délai réel.
 */
async function replayOctober17(): Promise<{ c: SimDevice; b: SimDevice; o: SimDevice; testPc: TaskId }> {
  const c = await createSimDevice(C_ID, { name: 'Ancien PC', start: '2026-10-15T08:00:00.000Z' });
  const o = await createSimDevice(O_ID, { name: 'iPhone', clock: c.clock, devicePlatform: 'ios' });
  const b = await createSimDevice(B_ID, { name: 'Nouveau PC', clock: c.clock });
  devices = [c, b, o];
  // L'ancien PC ouvre l'époque 1 ; l'iPhone s'associe, puis le nouveau PC (fenêtre où l'ancien n'est pas encore oublié).
  await setupFirst(c);
  await c.cycle();
  await pair(c, o);
  await o.cycle();
  syncFolders(devices);
  await pair(c, b);
  await b.cycle();
  syncFolders(devices);
  await rounds([c, o, b], 2);
  syncFolders(devices);
  // Sauvegarde de l'iPhone, antérieure à « Test Pc ».
  const copy = await backupOf(o);
  c.clock.advance(24 * 60 * 60_000);
  // 16 octobre : l'ancien PC crée « Test Pc » ; le nouveau PC la lit ; l'iPhone ne cycle pas (ne la lit jamais).
  const testPc = (await c.createTask('Test Pc')).id;
  await c.cycle();
  syncFolders(devices);
  await b.cycle();
  syncFolders(devices);
  expect((await b.task(testPc))?.title, 'le nouveau PC détient « Test Pc »').toBe('Test Pc');
  expect(await o.task(testPc), 'l’iPhone n’a jamais lu « Test Pc »').toBeNull();
  // 17 octobre : l'ancien PC est éteint (jamais oublié) ; l'iPhone restaure et applique partout.
  c.clock.advance(24 * 60 * 60_000);
  await restore(o, copy);
  expect((await o.cycle()).phase).toBe('restore-choice');
  await o.service.chooseRestoreOption('apply-everywhere');
  await rounds([o, b]);
  expect(injected.switches, 'le nouveau PC a changé d’époque par switchEpoch').toContain(B_ID);
  return { c, b, o, testPc };
}

describe('Y-TECH-04 critère 7 : règle de report validée (option B), cas réel du 2026-10-17 à trois appareils', () => {
  it('option B (code en production) : « Test Pc » de l’ancien PC, non lue par l’iPhone, survit chez l’iPhone et chez le nouveau PC', async () => {
    const { b, o, testPc } = await replayOctober17();
    expect((await o.task(testPc))?.title, 'iPhone').toBe('Test Pc');
    expect((await b.task(testPc))?.title, 'nouveau PC').toBe('Test Pc');
    expect((await o.task(testPc))?.deletedAt ?? null, 'iPhone : non supprimée').toBeNull();
    expect((await b.task(testPc))?.deletedAt ?? null, 'nouveau PC : non supprimée').toBeNull();
    expect(await taskSnapshot(o)).toEqual(await taskSnapshot(b));
  });

  it('preuve de détection : avec la règle A injectée (ce fichier seulement), le même scénario perd « Test Pc » sur les deux appareils', async () => {
    injected.ruleA = true;
    const { b, o, testPc } = await replayOctober17();
    expect(await o.task(testPc), 'iPhone : perdue avec la règle A').toBeNull();
    expect(await b.task(testPc), 'nouveau PC : perdue avec la règle A').toBeNull();
    expect(await taskSnapshot(o)).toEqual(await taskSnapshot(b));
  });
});
