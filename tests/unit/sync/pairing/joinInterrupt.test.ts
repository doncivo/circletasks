import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SpaceId } from '../../../../src/domain/types';
import type { SyncStatus } from '../../../../src/platform/sync/types';
import { JOIN_CHUNK_RECORDS, JOIN_META, type JoinState } from '../../../../src/sync/join';
import { setSnapshotTestHooks } from '../../../../src/sync/snapshot';
import { propagate } from '../../../sim/syncCloudSim';
import { armCrash } from '../../../sim/syncCrash';
import { createSimDevice, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-06 critère 13 (QA) : un arrêt brutal à **chaque** écriture du premier cycle d'un nouvel appareil (ajout au journal, état, transaction
 * de tranche, dernière transaction, curseurs), puis, pendant la reprise, un second arrêt à chacune des premières écritures. Dans tous les
 * cas : la reprise repart au même endroit (jamais en arrière de la position mémorisée), l'arrivée se termine, rien ne manque, rien n'est
 * en double, les données locales du nouvel appareil sont gardées et publiées, et l'état d'arrivée est effacé.
 *
 * Aucun délai : l'arrêt est un compteur d'écritures (`tests/sim/syncCrash.ts`).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSO = '00000000-0000-4000-8000-000000000002' as SpaceId;
const NOTE = 'n'.repeat(6_000);
const TASKS = 60;

let devices: SimDevice[] = [];
afterEach(async () => {
  setSnapshotTestHooks({});
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

interface Scenario {
  readonly pc: SimDevice;
  readonly recoveryKey: string;
}

/** PC avec assez de tâches pour au moins deux tranches de lignes ; une clé de secours valable pour tous les nouveaux appareils. */
async function pcScenario(tasks: number, track = true): Promise<Scenario> {
  const pc = await createSimDevice(A_ID, { name: 'PC' });
  if (track) devices.push(pc);
  await setupFirst(pc);
  for (let i = 0; i < tasks; i += 1) await pc.createTask(`Tâche ${String(i)}`, { note: NOTE });
  expect((await pc.cycle()).phase).toBe('idle');
  await pc.platform.key.openPairing('show');
  const { recoveryKey } = await pc.platform.key.pairingPayload();
  await pc.platform.key.closePairing();
  return { pc, recoveryKey };
}

/** PC partagé par les essais d'arrêt (jamais modifié : seuls les nouveaux appareils sont jetés après chaque essai). */
let shared: Scenario;
beforeAll(async () => {
  shared = await pcScenario(TASKS, false);
}, 60_000);
afterAll(async () => {
  await shared.pc.close();
});

/** Nouvel appareil prêt au premier cycle : clé importée, avec deux tâches locales (données d'exemple, usage avant association). */
async function newDevice(s: Scenario): Promise<SimDevice> {
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: s.pc.clock });
  devices.push(b);
  await b.createTask('Local Pro');
  await b.createTask('Local Perso', { spaceId: PERSO });
  propagate(s.pc.folder, b.folder, s.pc.id);
  await b.platform.folder.choose();
  await b.platform.key.openPairing('import');
  await b.platform.key.import({ recoveryKey: s.recoveryKey });
  return b;
}

const joinState = async (d: SimDevice): Promise<JoinState | null> => {
  const raw = await d.data.repos.sync.getMeta(JOIN_META);
  return raw === null ? null : (JSON.parse(raw) as JoinState);
};

function watchProgress(d: SimDevice): { readonly seen: { done: number; total: number }[] } {
  const seen: { done: number; total: number }[] = [];
  d.service.subscribe(() => {
    const progress: SyncStatus['progress'] = d.service.status().progress;
    if (progress) seen.push({ ...progress });
  });
  return { seen };
}

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);

const EXPECTED = [...Array.from({ length: TASKS }, (_, i) => `Tâche ${String(i)}`), 'Local Pro', 'Local Perso'].sort();

/** Arrivée terminée : tout est là, une seule fois, et publié (le PC reçoit les deux tâches locales). */
async function expectArrived(s: Scenario, b: SimDevice): Promise<void> {
  expect(await joinState(b)).toBeNull();
  expect(await b.data.repos.sync.getMeta('resume')).toBeNull();
  expect(await titles(b)).toEqual(EXPECTED);
  expect(await b.driver.select('SELECT id FROM space ORDER BY id')).toHaveLength(2);
  syncFolders(devices);
  expect((await s.pc.cycle()).phase).toBe('idle');
  expect(await titles(s.pc)).toEqual(EXPECTED);
  expect(await s.pc.driver.select('SELECT id FROM space ORDER BY id')).toHaveLength(2);
  expect(await taskSnapshot(b)).toEqual(await taskSnapshot(s.pc));
}

describe('arrivée interrompue à chaque écriture, reprise au même endroit (critère 13, QA)', () => {
  /** Écritures du premier cycle d'un nouvel appareil sans arrêt (mesure) ; chaque rang jusqu'à cette borne a son essai. */
  const WRITES = 24; // 23 + l'entrée de départ de `sync_meta.join` (revue 1)

  it('scénario : plusieurs tranches de lignes, et le premier cycle fait exactement WRITES écritures (sinon ajuster la borne)', async () => {
    const b = await newDevice(shared);
    const probe = armCrash(b, null);
    const { seen } = watchProgress(b);
    expect((await b.cycle()).phase).toBe('idle');
    probe.disarm();
    expect(seen.at(-1)?.total ?? 0).toBeGreaterThan(JOIN_CHUNK_RECORDS);
    expect(probe.writes).toBe(WRITES);
  });

  for (let n = 1; n <= WRITES; n += 1) {
    it(`arrêt avant l’écriture ${String(n)} du premier cycle : reprise au même endroit, aucune perte, aucun doublon`, async () => {
      const b = await newDevice(shared);
      const crash = armCrash(b, n);
      const first = await b.cycle();
      expect(crash.crashed).toBe(true);
      expect(first.phase).not.toBe('idle');
      crash.disarm();
      await b.restart();
      const before = await joinState(b);
      const { seen } = watchProgress(b);
      expect((await b.cycle()).phase).toBe('idle');
      // Au même endroit : la première progression publiée est la position mémorisée (jamais en arrière).
      if (before !== null && before.done > 0) expect(seen[0]?.done).toBe(before.done);
      expect(await joinState(b)).toBeNull();
      expect(await b.data.repos.sync.getMeta('resume')).toBeNull();
      expect(await titles(b)).toEqual(EXPECTED);
      expect(await b.driver.select('SELECT id FROM space ORDER BY id')).toHaveLength(2);
    });
  }

  it('second arrêt pendant la reprise (aux premières écritures) : la position ne recule jamais, l’arrivée finit, les données locales sont publiées', async () => {
    const s = await pcScenario(TASKS);
    const b = await newDevice(s);
    let calls = 0;
    setSnapshotTestHooks({
      beforeBatch: () => {
        calls += 1;
        if (calls === 2) throw new Error('arrêt simulé');
      },
    });
    expect((await b.cycle()).phase).toBe('error');
    setSnapshotTestHooks({});
    let last = (await joinState(b))?.done ?? -1;
    expect(last).toBe(JOIN_CHUNK_RECORDS);
    for (const k of [1, 2, 3, 4]) {
      const crash = armCrash(b, k);
      await b.cycle();
      crash.disarm();
      await b.restart();
      const now = (await joinState(b))?.done ?? last;
      expect(now, `après le second arrêt ${String(k)}`).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect((await b.cycle()).phase).toBe('idle');
    await expectArrived(s, b);
  });

  it('arrêt dans la dernière transaction (curseurs, traces) : la reprise reste due, puis pose les curseurs', async () => {
    const s = await pcScenario(TASKS);
    const b = await newDevice(s);
    setSnapshotTestHooks({
      beforeFinal: () => {
        throw new Error('arrêt simulé');
      },
    });
    expect((await b.cycle()).phase).toBe('error');
    setSnapshotTestHooks({});
    const stopped = await joinState(b);
    expect(stopped).not.toBeNull();
    expect(stopped?.failure).toBe('io');
    expect(await b.data.repos.sync.getMeta('resume')).not.toBeNull();
    await b.restart();
    expect((await b.cycle()).phase).toBe('idle');
    await expectArrived(s, b);
  });

  it('un échec en cours d’arrivée n’est jamais seulement journalisé : phase error, échec mémorisé dans la base (code seulement), effacé à la réussite', async () => {
    const s = await pcScenario(TASKS);
    const b = await newDevice(s);
    setSnapshotTestHooks({
      beforeBatch: () => {
        throw new Error('disque plein');
      },
    });
    expect((await b.cycle()).phase).toBe('error');
    expect((await joinState(b))?.failure).toBe('io');
    expect(JSON.stringify(await joinState(b))).not.toContain('disque');
    setSnapshotTestHooks({});
    expect((await b.cycle()).phase).toBe('idle');
    expect(await joinState(b)).toBeNull();
  });
});
