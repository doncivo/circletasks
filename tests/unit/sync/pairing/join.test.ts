import { afterEach, describe, expect, it } from 'vitest';
import type { SpaceId, TaskId } from '../../../../src/domain/types';
import type { SyncStatus } from '../../../../src/platform/sync/types';
import { JOIN_CHUNK_RECORDS, JOIN_META, type JoinState } from '../../../../src/sync/join';
import { setSnapshotTestHooks } from '../../../../src/sync/snapshot';
import { armCrash } from '../../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-06 critères 13 et 14 (ADR 0011 sections 5.5 et 10.3) : le nouvel appareil rejoint par l'instantané en fusion, avec progression en
 * enregistrements (`snap-end`), reprise au même endroit après un arrêt, échec mémorisé jusqu'à la réussite (exigence d'Ali), et
 * fusion de ses données locales (rien n'est effacé, espaces fixes sans doublon, réglages locaux gardés pour lui).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERSO = '00000000-0000-4000-8000-000000000002' as SpaceId;

let devices: SimDevice[] = [];
afterEach(async () => {
  setSnapshotTestHooks({});
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** PC avec `count` tâches dont les notes remplissent plusieurs enregistrements d'instantané (64 Kio chacun). */
async function pcWithTasks(count: number): Promise<SimDevice> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  devices.push(a);
  await setupFirst(a);
  for (let i = 0; i < count; i += 1) await a.createTask(`Tâche ${String(i)}`, { note: 'n'.repeat(6_000) });
  expect((await a.cycle()).phase).toBe('idle');
  return a;
}

async function joiner(a: SimDevice, options: { readonly clockOffsetMs?: number } = {}): Promise<SimDevice> {
  const b = options.clockOffsetMs === undefined ? await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock }) : await createSimDevice(B_ID, { name: 'iPhone', start: new Date(a.clock.nowMs() + options.clockOffsetMs).toISOString() });
  devices.push(b);
  return b;
}

const joinState = async (d: SimDevice): Promise<JoinState | null> => {
  const raw = await d.data.repos.sync.getMeta(JOIN_META);
  return raw === null ? null : (JSON.parse(raw) as JoinState);
};

/** Progressions publiées par le service pendant les cycles. */
function watchProgress(d: SimDevice): { readonly seen: { done: number; total: number }[] } {
  const seen: { done: number; total: number }[] = [];
  d.service.subscribe(() => {
    const progress: SyncStatus['progress'] = d.service.status().progress;
    if (progress) seen.push({ ...progress });
  });
  return { seen };
}

describe('nouvel appareil : instantané en fusion, progression, reprise (critère 13)', () => {
  it('progression en enregistrements jusqu’au total annoncé par snap-end, puis effacée ; tâches lisibles', async () => {
    const a = await pcWithTasks(60);
    const b = await joiner(a);
    await pair(a, b);
    const { seen } = watchProgress(b);
    const status = await b.cycle();
    expect(status.phase).toBe('idle');
    expect(status.progress).toBeNull();
    expect(seen.length).toBeGreaterThan(2);
    const total = seen[0]?.total ?? 0;
    expect(total).toBeGreaterThan(JOIN_CHUNK_RECORDS);
    expect(seen.every((p) => p.total === total)).toBe(true);
    expect(seen.map((p) => p.done)).toEqual([...seen.map((p) => p.done)].sort((x, y) => x - y));
    expect(seen.at(-1)).toEqual({ done: total, total });
    expect(await joinState(b)).toBeNull();
    syncFolders(devices);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('un arrêt au milieu : échec mémorisé, persistant au redémarrage, puis reprise au même endroit et effacement à la réussite', async () => {
    // Au moins trois tranches de lignes : l'arrêt a lieu dans la troisième.
    const a = await pcWithTasks(130);
    const b = await joiner(a);
    await pair(a, b);
    let calls = 0;
    setSnapshotTestHooks({
      beforeBatch: () => {
        calls += 1;
        if (calls === 3) throw new Error('arrêt simulé');
      },
    });
    const failed = await b.cycle();
    expect(failed.phase).toBe('error');
    const stopped = await joinState(b);
    expect(stopped?.done).toBe(2 * JOIN_CHUNK_RECORDS);
    expect(stopped?.failure).toBe('io');
    // Redémarrage : l'échec est toujours là (table locale), jamais effacé par la seule relance.
    setSnapshotTestHooks({});
    await b.restart();
    expect((await joinState(b))?.failure).toBe('io');
    const { seen } = watchProgress(b);
    expect((await b.cycle()).phase).toBe('idle');
    expect(seen[0]?.done).toBe(2 * JOIN_CHUNK_RECORDS);
    expect(await joinState(b)).toBeNull();
    syncFolders(devices);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('instantané refusé (horloge du nouvel appareil en retard de 2 h) : échec mémorisé et affiché, effacé quand l’horloge est juste', async () => {
    const a = await pcWithTasks(3);
    const b = await joiner(a, { clockOffsetMs: -2 * 3_600_000 });
    await pair(a, b);
    const status = await b.cycle();
    expect(status.phase).toBe('clock-ahead');
    expect((await joinState(b))?.failure).toBe('clock-ahead');
    b.clock.set(a.clock.nowMs());
    expect((await b.cycle()).phase).toBe('idle');
    expect(await joinState(b)).toBeNull();
  });

  it('instantané encore dans le nuage : attente (aucun échec mémorisé), puis arrivée normale', async () => {
    const a = await pcWithTasks(3);
    const b = await joiner(a);
    await pair(a, b);
    const epoch = [...(b.folder.devices.get(A_ID)?.epochs.keys() ?? [])][0] as string;
    b.folder.setAvailability(A_ID, `${epoch}/s-00000001.cts`, 'cloud');
    const waiting = await b.cycle();
    expect(waiting.phase).toBe('waiting-icloud');
    expect((await joinState(b))?.failure ?? null).toBeNull();
    b.folder.setAvailability(A_ID, `${epoch}/s-00000001.cts`, 'local');
    expect((await b.cycle()).phase).toBe('idle');
    expect(await joinState(b)).toBeNull();
  });
});

describe('arrivée suivie dès le premier cycle (revue 1, bloquant)', () => {
  /** Premier instantané du PC (époque 1). */
  const snapshotFile = (b: SimDevice): string => `${[...(b.folder.devices.get(A_ID)?.epochs.keys() ?? [])][0] as string}/s-00000001.cts`;

  it('premier cycle en attente d’iCloud : l’arrivée est mémorisée, le second cycle passe par join (reprise au même endroit)', async () => {
    const a = await pcWithTasks(130);
    const b = await joiner(a);
    await pair(a, b);
    b.folder.setAvailability(A_ID, snapshotFile(b), 'cloud');
    expect((await b.cycle()).phase).toBe('waiting-icloud');
    expect(await joinState(b)).toMatchObject({ done: 0, failure: null });
    b.folder.setAvailability(A_ID, snapshotFile(b), 'local');
    let calls = 0;
    setSnapshotTestHooks({
      beforeBatch: () => {
        calls += 1;
        if (calls === 3) throw new Error('arrêt simulé');
      },
    });
    expect((await b.cycle()).phase).toBe('error');
    expect(await joinState(b)).toMatchObject({ done: 2 * JOIN_CHUNK_RECORDS, failure: 'io' });
    setSnapshotTestHooks({});
    const { seen } = watchProgress(b);
    expect((await b.cycle()).phase).toBe('idle');
    expect(seen[0]?.done).toBe(2 * JOIN_CHUNK_RECORDS);
    expect(seen[0]?.total).toBeGreaterThan(2 * JOIN_CHUNK_RECORDS);
    expect(await joinState(b)).toBeNull();
    syncFolders(devices);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('arrêt juste après la transaction de l’époque, avant toute écriture de join : le cycle suivant passe par join', async () => {
    const a = await pcWithTasks(60);
    // Rang de l'écriture qui suit la transaction posant l'époque, mesuré sur un premier appareil neuf.
    const probeDevice = await joiner(a);
    await pair(a, probeDevice);
    const probe = armCrash(probeDevice, null);
    let afterEpochTx = -1;
    const original = probeDevice.data.transaction.bind(probeDevice.data);
    probeDevice.data.transaction = async (work) => {
      const result = await original(work);
      if (afterEpochTx < 0 && (await probeDevice.data.repos.sync.getMeta('epoch')) !== null) afterEpochTx = probe.writes + 1;
      return result;
    };
    expect((await probeDevice.cycle()).phase).toBe('idle');
    probe.disarm();
    expect(afterEpochTx).toBeGreaterThan(1);
    // Même scénario sur un autre appareil neuf, arrêté juste après cette transaction.
    const c = await createSimDevice('cccccccc-cccc-4ccc-8ccc-cccccccccccc', { name: 'iPhone 2', clock: a.clock });
    devices.push(c);
    await pair(a, c);
    const crash = armCrash(c, afterEpochTx);
    await c.cycle();
    expect(crash.crashed).toBe(true);
    crash.disarm();
    expect(await c.data.repos.sync.getMeta('epoch')).not.toBeNull();
    await c.restart();
    const { seen } = watchProgress(c);
    expect((await c.cycle()).phase).toBe('idle');
    // Progression en enregistrements de l'instantané (join), et non en lignes (reprise ordinaire : plus de 60).
    const total = seen.at(-1)?.total ?? 0;
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(60);
    expect(await joinState(c)).toBeNull();
  });
});

describe('appareil qui rejoint avec des données locales (critère 14)', () => {
  it('rien n’est effacé : union des deux jeux, deux espaces seulement, sample.ids reste local', async () => {
    const a = await pcWithTasks(2);
    const b = await joiner(a);
    const local1 = await b.createTask('Exemple Pro');
    const local2 = await b.createTask('Exemple Perso', { spaceId: PERSO });
    await b.data.repos.settings.set('sample.ids', { tasks: [local1.id, local2.id], routines: [], checklists: [] });
    await pair(a, b);
    expect((await b.cycle()).phase).toBe('idle');
    syncFolders(devices);
    expect((await a.cycle()).phase).toBe('idle');
    for (const d of devices) {
      const titles = (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
      expect(titles).toEqual(['Exemple Perso', 'Exemple Pro', 'Tâche 0', 'Tâche 1']);
      expect(await d.driver.select('SELECT id FROM space ORDER BY id')).toEqual([{ id: '00000000-0000-4000-8000-000000000001' }, { id: PERSO }]);
    }
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
    expect((await b.task(local1.id as TaskId))?.title).toBe('Exemple Pro');
    expect((await b.data.repos.settings.get('sample.ids')).tasks).toEqual([local1.id, local2.id]);
    expect((await a.data.repos.settings.get('sample.ids')).tasks).toEqual([]);
  });
});

describe('codes distincts de l’ouverture (revue 2, audit 4)', () => {
  it('fenêtre déjà ouverte : already-open ; application pas au premier plan : not-foreground ; refus : consent-denied', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    devices.push(a);
    await setupFirst(a);
    expect((await a.cycle()).phase).toBe('idle');
    const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: { code?: string }) => e.code ?? 'autre');
    await a.platform.key.openPairing('show');
    expect(await code(a.platform.key.openPairing('show'))).toBe('already-open');
    expect(await code(a.platform.key.openPairing('import'))).toBe('already-open');
    await a.platform.key.closePairing();
    a.platform.testing.setForeground(false);
    expect(await code(a.platform.key.openPairing('show'))).toBe('not-foreground');
    expect(await code(a.platform.key.openPairing('import'))).toBe('not-foreground');
    a.platform.testing.setForeground(true);
    a.platform.testing.setConsent(false);
    expect(await code(a.platform.key.openPairing('show'))).toBe('consent-denied');
  });
});
