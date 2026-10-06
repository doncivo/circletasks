import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRecords, buildRecordsSliced, createSlicer, materializeOutbox, NO_SLICING } from '../../../../src/sync/publisher';
import type { TaskId } from '../../../../src/domain/types';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * QA de Y-04 / Y-05 critère 6 : la publication d'une grosse file en tâches courtes (`publisher.ts`). Preuves : résultat publié identique
 * avec et sans découpage ; aucune écriture de l'utilisateur perdue quand elle tombe entre deux tranches (balayage de points de
 * reprise : lecture du décompte, lecture dans la transaction, construction des enregistrements) ou entre deux ajouts au journal ;
 * file modifiée pendant la publication ; arrêt brutal entre deux tranches. Aucun délai réel : `performance.now` est piloté par un
 * compteur (une unité par appel) et la reprise de la boucle d'événements (`scheduler.yield`) est remplacée par un passage de
 * `setImmediate`, qui n'attend rien.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const IPHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COUNT = 1_100;
const taskId = (i: number): TaskId => `${String(i).padStart(8, '0')}-2222-4222-8222-aaaaaaaaaaaa` as TaskId;

let devices: SimDevice[] = [];
const globals = globalThis as { scheduler?: unknown };

afterEach(async () => {
  vi.restoreAllMocks();
  delete globals.scheduler;
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

interface Slicing {
  /** Nombre de retours à la boucle d'événements. */
  readonly yields: () => number;
}

/** Découpage forcé : une unité de « temps » par lecture de l'horloge, tranche de 50 unités ; `onYield(n)` à chaque retour (n à partir de 1). */
function forceSlicing(onYield: (n: number) => void = () => undefined): Slicing {
  let tick = 0;
  let yields = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (tick += 1));
  globals.scheduler = {
    yield: async () => {
      yields += 1;
      onYield(yields);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  return { yields: () => yields };
}

/** Aucun découpage : l'horloge ne bouge pas, la tranche n'est jamais écoulée. */
function noSlicing(): Slicing {
  vi.spyOn(performance, 'now').mockImplementation(() => 0);
  let yields = 0;
  globals.scheduler = { yield: () => void (yields += 1) };
  return { yields: () => yields };
}

function stopSlicing(): void {
  vi.restoreAllMocks();
  delete globals.scheduler;
}

interface Seeded {
  readonly pc: SimDevice;
  readonly iphone: SimDevice;
}

/** PC et iPhone associés ; le PC a `count` tâches accumulées hors ligne, pas encore publiées. */
async function seeded(count = COUNT, noteSize = 50): Promise<Seeded> {
  const pc = await createSimDevice(PC_ID, { name: 'PC' });
  const iphone = await createSimDevice(IPHONE_ID, { name: 'iPhone', clock: pc.clock });
  devices = [pc, iphone];
  await setupFirst(pc);
  await pc.cycle();
  await pair(pc, iphone);
  await iphone.cycle();
  syncFolders(devices);
  await pc.cycle();
  pc.clock.advance(1_000);
  const model = await pc.createTask('Tâche 0', { id: taskId(0), note: 'x'.repeat(noteSize), sortOrder: 1 });
  await pc.data.transaction(async (repos) => {
    await repos.tasks.createMany(Array.from({ length: count - 1 }, (_, i) => ({ ...model, id: taskId(i + 1), title: `Tâche ${String(i + 1)}`, note: 'x'.repeat(noteSize) })));
  });
  expect(await pc.data.repos.sync.outboxCount()).toBe(count);
  return { pc, iphone };
}

/** Opérations publiées par un appareil dans son propre dossier, dans l'ordre. */
function journalOps(device: SimDevice): unknown[] {
  const out: unknown[] = [];
  for (const epoch of device.folder.devices.get(device.id)?.epochs.values() ?? []) {
    for (const [, segment] of [...epoch.segments.entries()].sort((a, b) => a[0] - b[0])) {
      for (const line of segment.lines) out.push(...((JSON.parse(line.text) as { ops?: unknown[] }).ops ?? []));
    }
  }
  return out;
}

/** Combien de fois chaque tâche est créée (champ `title` publié) dans le journal du PC. */
function creations(device: SimDevice): Map<string, number> {
  const seen = new Map<string, number>();
  for (const op of journalOps(device) as { t: string; id: string; f: Record<string, unknown> }[]) {
    if (op.t === 'task' && 'title' in op.f) seen.set(op.id, (seen.get(op.id) ?? 0) + 1);
  }
  return seen;
}

/** Les écritures de l'utilisateur pendant une publication : réécriture du premier et du dernier élément de la file, suppression, création. */
function userWrites(pc: SimDevice, count = COUNT): Promise<string>[] {
  const settle = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (error: unknown) => String(error));
  return [
    settle(pc.updateTask(taskId(0), { title: 'Réécrite A' })),
    settle(pc.updateTask(taskId(count - 1), { title: 'Réécrite B' })),
    settle(pc.deleteTask(taskId(Math.floor(count / 2)))),
    settle(pc.createTask('Nouvelle', { id: taskId(count) })),
  ];
}

/** Retour en ligne sans découpage : chaque appareil lit puis publie, deux tours. */
async function settle({ pc, iphone }: Seeded): Promise<void> {
  stopSlicing();
  for (let i = 0; i < 2; i += 1) {
    syncFolders(devices);
    await pc.cycle();
    syncFolders(devices);
    await iphone.cycle();
  }
  syncFolders(devices);
  await pc.cycle();
}

async function expectUserWritesEverywhere({ pc, iphone }: Seeded, count = COUNT): Promise<void> {
  expect(await pc.data.repos.sync.outboxCount()).toBe(0);
  for (const d of [pc, iphone]) {
    expect((await d.task(taskId(0)))?.title).toBe('Réécrite A');
    expect((await d.task(taskId(count - 1)))?.title).toBe('Réécrite B');
    expect((await d.task(taskId(Math.floor(count / 2))))?.deletedAt).not.toBeNull();
    expect((await d.task(taskId(count)))?.title).toBe('Nouvelle');
    expect(await d.driver.select('SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL')).toEqual([{ n: count }]);
  }
  expect(await taskSnapshot(iphone)).toEqual(await taskSnapshot(pc));
}

describe('Y-05 critère 6 : le découpeur (createSlicer)', () => {
  it('Y-05 critère 6 : ne rend la main qu’une fois la tranche écoulée, puis repart d’une tranche neuve', async () => {
    let yields = 0;
    globals.scheduler = { yield: () => void (yields += 1) };
    let now = 0;
    const slicer = createSlicer(() => now, 50);
    await slicer.pause();
    now = 49;
    await slicer.pause();
    expect(yields).toBe(0);
    now = 50;
    await slicer.pause();
    expect(yields).toBe(1);
    now = 99;
    await slicer.pause();
    expect(yields).toBe(1);
    now = 100;
    await slicer.pause();
    expect(yields).toBe(2);
  });

  it('Y-05 critère 6 : sans `scheduler.yield`, la reprise passe par un message (jamais une minuterie) et rend bien la main', async () => {
    delete globals.scheduler;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    let now = 0;
    const slicer = createSlicer(() => now, 50);
    now = 60;
    let resumedAfterMacrotask = false;
    const paused = slicer.pause().then(() => {
      resumedAfterMacrotask = true;
    });
    expect(resumedAfterMacrotask).toBe(false);
    await paused;
    expect(resumedAfterMacrotask).toBe(true);
    expect(timers).not.toHaveBeenCalled();
  });
});

describe('Y-05 critère 6 : résultat publié identique avec et sans découpage', () => {
  it('Y-05 critère 6 : même file lue et mise en forme avec et sans tranches (opérations, entrées, enregistrements)', async () => {
    const { pc } = await seeded();
    // Plusieurs hlc par ligne et des suppressions : des groupes de hlc de toutes tailles.
    for (let i = 0; i < 300; i += 1) {
      pc.clock.advance(1);
      await pc.updateTask(taskId(i), { title: `Titre ${String(i)}` });
    }
    for (let i = 600; i < 650; i += 1) await pc.deleteTask(taskId(i));
    const read = (slicer: Parameters<typeof materializeOutbox>[5], limit?: number) => pc.data.transaction((repos) => materializeOutbox(repos, pc.id, null, limit, [], slicer));

    const plain = await read(NO_SLICING);
    const slicing = forceSlicing();
    const sliced = await read(createSlicer());
    expect(slicing.yields()).toBeGreaterThan(5);
    stopSlicing();
    expect(sliced).toEqual(plain);
    expect(plain.ops.length).toBeGreaterThan(COUNT);

    // Limite qui ne tombe pas sur une page de 500.
    const plainLimited = await read(NO_SLICING, 777);
    forceSlicing();
    const slicedLimited = await read(createSlicer(), 777);
    stopSlicing();
    expect(slicedLimited).toEqual(plainLimited);
    expect(plainLimited.entries.length).toBeLessThanOrEqual(777);

    const noop = (): void => undefined;
    const direct = buildRecords(plain.ops, SCHEMA_VERSION, noop);
    const counting = forceSlicing();
    const cut = await buildRecordsSliced(plain.ops, SCHEMA_VERSION, noop, createSlicer());
    expect(counting.yields()).toBeGreaterThan(5);
    expect(cut).toEqual(direct);
  }, 120_000);

  it('Y-05 critère 6 : deux appareils identiques, l’un publie en tranches, l’autre non : mêmes opérations dans le même ordre, file vide', async () => {
    const sliced = await seeded();
    const slicing = forceSlicing();
    await sliced.pc.cycle();
    expect(slicing.yields()).toBeGreaterThan(10);
    expect(await sliced.pc.data.repos.sync.outboxCount()).toBe(0);
    const slicedOps = journalOps(sliced.pc);
    stopSlicing();
    await Promise.all(devices.map((d) => d.close()));

    const plain = await seeded();
    const none = noSlicing();
    await plain.pc.cycle();
    expect(none.yields()).toBe(0);
    expect(await plain.pc.data.repos.sync.outboxCount()).toBe(0);
    expect(journalOps(plain.pc)).toEqual(slicedOps);
    expect(slicedOps.length).toBe(COUNT);
  }, 120_000);
});

describe('Y-05 critère 6 : aucune écriture perdue quand l’utilisateur écrit entre deux tranches', () => {
  it.each([1, 2, 3, 4, 8, 16, 24, 32, 40])('Y-05 critère 6 : écritures au retour n° %i à la boucle d’événements : toutes publiées, les deux appareils convergent', async (at) => {
    const s = await seeded();
    const writes: Promise<string>[] = [];
    let fired = false;
    forceSlicing((n) => {
      if (n === at) {
        fired = true;
        writes.push(...userWrites(s.pc));
      }
    });
    const status = await s.pc.cycle();
    expect(fired, `moins de ${String(at)} retours à la boucle d’événements`).toBe(true);
    expect(['idle', 'error']).toContain(status.phase);
    expect(await Promise.all(writes)).toEqual(['ok', 'ok', 'ok', 'ok']);
    await settle(s);
    await expectUserWritesEverywhere(s);
  }, 120_000);

  it('Y-05 critère 6 : écritures à chaque retour (toutes les phases à la fois) : toutes publiées', async () => {
    const s = await seeded(1_100);
    const writes: Promise<string>[] = [];
    let counter = 0;
    forceSlicing((n) => {
      // Une réécriture du même titre à chaque retour : la dernière doit gagner partout.
      counter = n;
      writes.push(
        s.pc.updateTask(taskId(0), { title: `Version ${String(n)}` }).then(
          () => 'ok',
          (error: unknown) => String(error),
        ),
      );
    });
    await s.pc.cycle();
    expect(counter).toBeGreaterThan(10);
    expect((await Promise.all(writes)).every((r) => r === 'ok')).toBe(true);
    await settle(s);
    for (const d of devices) expect((await d.task(taskId(0)))?.title).toBe(`Version ${String(counter)}`);
    expect(await taskSnapshot(devices[1] as SimDevice)).toEqual(await taskSnapshot(devices[0] as SimDevice));
  }, 120_000);
});

describe('Y-05 critère 6 : file modifiée pendant la publication (entre deux ajouts au journal)', () => {
  it.each([1, 2, 3])('Y-05 critère 6 : écritures juste avant l’ajout n° %i : publiées au cycle suivant, aucune perte', async (at) => {
    const s = await seeded(COUNT, 4_000);
    const platform = s.pc.platform as unknown as { appendJournal: (...args: unknown[]) => Promise<unknown> };
    const real = platform.appendJournal.bind(s.pc.platform);
    let appends = 0;
    let fired = false;
    platform.appendJournal = async (...args) => {
      appends += 1;
      if (appends === at) {
        fired = true;
        expect(await Promise.all(userWrites(s.pc))).toEqual(['ok', 'ok', 'ok', 'ok']);
      }
      return real(...args);
    };
    const status = await s.pc.cycle();
    expect(fired, `moins de ${String(at)} ajouts`).toBe(true);
    expect(status.phase).toBe('idle');
    // Les écritures faites pendant la publication sont encore dans la file (ou déjà parties) : jamais retirées sans être publiées.
    expect(await s.pc.data.repos.sync.outboxCount()).toBeGreaterThan(0);
    await settle(s);
    await expectUserWritesEverywhere(s);
  }, 120_000);

  it('Y-05 critère 6 : la ligne réécrite pendant l’ajout garde son entrée de file (le retrait se fait par numéro)', async () => {
    const s = await seeded(COUNT, 4_000);
    const platform = s.pc.platform as unknown as { appendJournal: (...args: unknown[]) => Promise<unknown> };
    const real = platform.appendJournal.bind(s.pc.platform);
    let appends = 0;
    platform.appendJournal = async (...args) => {
      appends += 1;
      if (appends === 1) await s.pc.updateTask(taskId(0), { title: 'Réécrite pendant l’ajout' });
      return real(...args);
    };
    await s.pc.cycle();
    const left = await s.pc.driver.select("SELECT field FROM sync_outbox WHERE table_name = 'task' AND row_id = ?", [taskId(0)]);
    expect(left).toEqual([{ field: 'title' }]);
    await settle(s);
    for (const d of devices) expect((await d.task(taskId(0)))?.title).toBe('Réécrite pendant l’ajout');
  }, 120_000);
});

describe('Y-05 critère 6 : arrêt brutal entre deux tranches', () => {
  it.each([1, 2, 3, 4, 8, 16, 24, 32, 40])('Y-05 critère 6 : arrêt au retour n° %i à la boucle d’événements : rien n’est perdu ni publié à moitié ; après redémarrage, chaque tâche une seule fois', async (at) => {
    const s = await seeded();
    let fired = false;
    forceSlicing((n) => {
      if (n === at) {
        fired = true;
        throw new Error('arrêt simulé');
      }
    });
    const status = await s.pc.cycle();
    expect(fired, `moins de ${String(at)} retours à la boucle d’événements`).toBe(true);
    // Le cycle n'a pas abouti ; il le dit (jamais « À jour »), et rien n'a quitté la file ni été publié.
    expect(status.phase).not.toBe('idle');
    expect(await s.pc.data.repos.sync.outboxCount()).toBe(COUNT);
    expect(creations(s.pc).size).toBe(0);
    expect(await s.pc.data.repos.sync.getMeta('inflight')).toBeNull();
    stopSlicing();
    await s.pc.restart();
    expect((await s.pc.cycle()).phase).toBe('idle');
    expect(await s.pc.data.repos.sync.outboxCount()).toBe(0);
    const published = creations(s.pc);
    expect(published.size).toBe(COUNT);
    expect([...published.values()].every((n) => n === 1)).toBe(true);
    syncFolders(devices);
    expect((await s.iphone.cycle()).phase).toBe('idle');
    expect(await s.iphone.driver.select('SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL')).toEqual([{ n: COUNT }]);
    expect(await s.iphone.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 0 }]);
  }, 120_000);
});
