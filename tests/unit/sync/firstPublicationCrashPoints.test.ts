import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { statusLine } from '../../../src/features/sync/syncText';
import { syncBannerFor } from '../../../src/domain/syncBanners';
import type { DeviceId, TaskId } from '../../../src/domain/types';
import { SyncPlatformError, type SyncDeviceStatus, type SyncPlatform, type SyncStatus } from '../../../src/platform/sync/types';
import { createSyncService, HIDE_SYNC_DEADLINE_MS } from '../../../src/sync';
import { epochId } from '../../../src/domain/sync/format';
import { armCrash } from '../../sim/syncCrash';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-FIX-02 (B2 de docs/audit-1.0.md, ADR 0011 §30) : première publication interrompue. L'iPhone, associé et jamais publié, a une tâche `T`
 * en file ; un arrêt brutal (compteur d'écritures, `armCrash`, jamais le temps) tombe dans la fenêtre « intention, ajout, retrait de la
 * file, état ». Au redémarrage, la trace locale d'ajout (`META.inflight` ou `META.head`) borne la publication, Rust juge la tête : l'état
 * est publié, jamais `publish-blocked` pour toujours ; `T` arrive chez le PC une seule fois.
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PC_TASK = '7a000001-0000-4000-8000-aaaaaaaaaaaa' as TaskId;
const T_ID = '7b000001-0000-4000-8000-bbbbbbbbbbbb' as TaskId;
const T_TITLE = 'Écrite sur l’iPhone avant la première publication';
const NO_PERSISTED = { join: null, devices: null, blocking: null, readFailed: false } as const;

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** PC qui publie, iPhone associé avec la tâche `T` (et `extra` autres), jamais publié. */
async function joined(extra: readonly string[] = []): Promise<{ a: SimDevice; b: SimDevice; stateSeqs: number[] }> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  await a.createTask('Tâche PC', { id: PC_TASK });
  await a.cycle();
  await pair(a, b);
  await b.createTask(T_TITLE, { id: T_ID });
  for (const [i, title] of extra.entries()) await b.createTask(title, { id: `7b00000${String(i + 2)}-0000-4000-8000-bbbbbbbbbbbb` as TaskId });
  // `stateSeq` de chaque état accepté par la plateforme (Rust), dans l'ordre : jamais deux fois le même numéro.
  const stateSeqs: number[] = [];
  const real = b.platform.writeState.bind(b.platform);
  b.platform.writeState = async (input) => {
    await real(input);
    stateSeqs.push(input.state.stateSeq);
  };
  return { a, b, stateSeqs };
}

async function meta<T>(d: SimDevice, key: string): Promise<T | null> {
  const raw = await d.data.repos.sync.getMeta(key);
  return raw === null ? null : (JSON.parse(raw) as T);
}

const segments = (d: SimDevice): string[] => d.folder.fileNames(d.id).filter((f) => f.endsWith('.ctj'));
const events = (d: SimDevice, event: string) => d.logger.entries.filter((e) => e.event === event);

/** Rangs (comptés par `armCrash`) des écritures du premier cycle de l'iPhone : premier ajout et premier état qui le suit. */
async function writeRanks(): Promise<{ append: number; state: number }> {
  const { b } = await joined();
  const probe = armCrash(b, null);
  const platform = b.platform as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let append: number | null = null;
  let state: number | null = null;
  for (const name of ['appendJournal', 'writeState'] as const) {
    const real = platform[name] as (...args: unknown[]) => Promise<unknown>;
    platform[name] = (...args) => {
      if (name === 'appendJournal' && append === null) append = probe.writes + 1;
      if (name === 'writeState' && append !== null && state === null) state = probe.writes + 1;
      return real.apply(b.platform, args);
    };
  }
  await b.cycle();
  probe.disarm();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  if (append === null || state === null) throw new Error('premier cycle de l’iPhone sans ajout ni état');
  return { append, state };
}

/** Exécution de référence, sans arrêt : bases du PC et de l'iPhone, tête locale de l'iPhone. */
async function reference(): Promise<{ pc: unknown[]; phone: unknown[]; head: { segment: number; record: number } | null }> {
  const { a, b } = await joined();
  await b.cycle();
  syncFolders([a, b]);
  await a.cycle();
  const out = { pc: await taskSnapshot(a), phone: await taskSnapshot(b), head: await meta<{ segment: number; record: number }>(b, 'head') };
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  return out;
}

/** Arrêt brutal au rang donné pendant le premier cycle de l'iPhone, puis redémarrage. */
async function crashAt(rank: number, extra: readonly string[] = []): Promise<{ a: SimDevice; b: SimDevice; stateSeqs: number[] }> {
  const ctx = await joined(extra);
  const probe = armCrash(ctx.b, rank);
  await ctx.b.cycle();
  expect(probe.crashed).toBe(true);
  probe.disarm();
  await ctx.b.restart();
  return ctx;
}

/** Service de l'iPhone sur une plateforme donnée (pannes de `writeState`, échéance). */
function phoneService(b: SimDevice, platform: SyncPlatform, deadlineProbe?: Parameters<typeof createSyncService>[0]['deadlineProbe']): void {
  b.service = createSyncService({
    data: b.data,
    platform,
    hlc: b.hlc,
    clock: b.clock,
    deviceId: b.id,
    devicePlatform: 'ios',
    sv: SCHEMA_VERSION,
    appVersion: '0.4.0',
    logger: b.logger,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    ...(deadlineProbe ? { deadlineProbe } : {}),
  });
}

/** Convergence vers le PC : `T` une seule fois, tables identiques, iPhone vu par le PC. */
async function expectConverged(a: SimDevice, b: SimDevice): Promise<void> {
  syncFolders([a, b]);
  await a.cycle();
  const pcTasks = (await taskSnapshot(a)) as { id: string; title: string }[];
  expect(pcTasks.filter((t) => t.title === T_TITLE)).toHaveLength(1);
  expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  expect((await a.data.repos.sync.getStates()).some((r) => r.deviceId === b.id && r.stateSeq > 0)).toBe(true);
}

describe('Y-FIX-02 critère 3 : crashPoints de la première publication', () => {
  const crashPoints = [
    { point: 'P1', name: 'après l’écriture de inflight, avant appendJournal', rank: (r: { append: number; state: number }) => r.append },
    { point: 'P2', name: 'après appendJournal, avant la transaction', rank: (r: { append: number; state: number }) => r.append + 1 },
    { point: 'P3', name: 'après la transaction (META.head posé), avant writeState', rank: (r: { append: number; state: number }) => r.state },
    { point: 'P4', name: 'après writeState, avant la transaction de l’état', rank: (r: { append: number; state: number }) => r.state + 1 },
  ] as const;

  for (const cp of crashPoints) {
    it(`${cp.point} (${cp.name}) : au plus deux cycles jusqu’à state.ctx, jamais publish-blocked, résultat de l’exécution sans arrêt`, async () => {
      const ranks = await writeRanks();
      const ref = await reference();
      const { a, b, stateSeqs } = await crashAt(cp.rank(ranks));
      // P4 : l'état est écrit, seule sa transaction locale manque ; sinon aucun état.
      expect(b.folder.fileNames(b.id).includes('state.ctx')).toBe(cp.point === 'P4');
      const statuses: SyncStatus[] = [];
      for (let i = 0; i < 2 && !b.folder.fileNames(b.id).includes('state.ctx'); i += 1) statuses.push(await b.cycle());
      expect(b.folder.fileNames(b.id)).toContain('state.ctx');
      statuses.push(await b.cycle());
      for (const s of statuses) expect(s.warnings ?? []).not.toContain('publish-blocked');
      expect(statusLine(statuses.at(-1) as SyncStatus, b.clock.nowMs())).toContain('À jour');
      // Base de l'iPhone identique à l'exécution sans arrêt : tâches, file vide, même tête locale, aucune intention en suspens.
      expect(await taskSnapshot(b)).toEqual(ref.phone);
      expect(await b.data.repos.sync.outboxCount()).toBe(0);
      expect(await meta(b, 'inflight')).toBeNull();
      expect(await meta<{ segment: number; record: number }>(b, 'head')).toMatchObject({ segment: ref.head?.segment, record: ref.head?.record });
      // Aucun doublon d'enregistrement : un seul segment, une seule ligne.
      expect(segments(b)).toHaveLength(1);
      expect(b.folder.records(b.id, segments(b)[0] as string)).toHaveLength(1);
      // `stateSeq` strictement croissant, jamais réutilisé.
      expect(stateSeqs).toEqual([...new Set(stateSeqs)].sort((x, y) => x - y));
      await expectConverged(a, b);
      expect(await taskSnapshot(a)).toEqual(ref.pc);
    });
  }
});

describe('Y-FIX-02 critère 2 : reprise complète après l’arrêt P2 (inflight posé, segment écrit, stateSeq 0)', () => {
  it('un seul cycle : inflight nul, état { 1, 1 } de stateSeq 1, tête locale, file vide, journal de reprise, PC à jour', async () => {
    const ranks = await writeRanks();
    const { a, b, stateSeqs } = await crashAt(ranks.append + 1);
    // État laissé par l'arrêt : intention posée, segment écrit, aucun état, rien de publié en local.
    expect(await meta(b, 'inflight')).not.toBeNull();
    expect(segments(b)).toHaveLength(1);
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    expect(await meta(b, 'stateSeq')).toBeNull();
    const result = await b.cycle();
    expect(await meta(b, 'inflight')).toBeNull();
    expect(stateSeqs).toEqual([1]);
    expect(await meta<{ segment: number; record: number }>(b, 'head')).toMatchObject({ segment: 1, record: 1 });
    expect(await b.data.repos.sync.outboxCount()).toBe(0);
    expect(result.warnings ?? []).not.toContain('publish-blocked');
    expect(events(b, 'inflight-resolved').map((e) => e.detail)).toEqual([{ appended: true }]);
    expect(events(b, 'own-state-recovered').map((e) => e.detail)).toEqual([{ epoch: expect.any(String), source: 'inflight' }]);
    syncFolders([a, b]);
    await a.cycle();
    const state = (await a.data.repos.sync.getStates()).find((r) => r.deviceId === b.id);
    expect(state).toMatchObject({ headSegment: 1, headRecord: 1, stateSeq: 1 });
    await expectConverged(a, b);
  });
});

describe('Y-FIX-02 critère 4 : P1, ajout manqué', () => {
  it('Rust refuse la tête expect + count, inflight remis à nul, file gardée, T publié dans le segment 1 dès la reprise', async () => {
    const ranks = await writeRanks();
    const { a, b } = await crashAt(ranks.append);
    expect(await meta(b, 'inflight')).not.toBeNull();
    expect(segments(b)).toHaveLength(0);
    expect(await b.data.repos.sync.outboxCount()).toBeGreaterThan(0);
    const result = await b.cycle();
    expect(events(b, 'inflight-resolved').map((e) => e.detail)).toEqual([{ appended: false }]);
    expect(events(b, 'write-state-failed').map((e) => e.detail)).toEqual([{ code: 'state-mismatch' }]);
    // La file gardée a été republiée : segment 1 depuis le premier enregistrement, une seule ligne, tête { 1, 1 }.
    expect(segments(b)).toHaveLength(1);
    expect(segments(b)[0]).toMatch(/j-00000001\.ctj$/);
    expect(b.folder.records(b.id, segments(b)[0] as string)).toHaveLength(1);
    expect(b.folder.records(b.id, segments(b)[0] as string)[0]).toContain(T_ID);
    expect(await meta<{ segment: number; record: number }>(b, 'head')).toMatchObject({ segment: 1, record: 1 });
    expect(result.warnings ?? []).not.toContain('publish-blocked');
    await expectConverged(a, b);
  });
});

/**
 * Critère 5, côté iPhone seulement (périmètre de B2) : un premier ajout coupé laisse un segment 1 tronqué que Rust ne connaît pas ; l'état
 * est publié avec la tête de Rust, la file part dans le segment que Rust accepte (`max + 1`), une seule fois. Côté PC, le segment 1 tronqué
 * n'est jamais clos et tient le lecteur « en attente d'iCloud » : défaut de lecture distinct, déjà présent sur main, remonté dans la fiche
 * (Écarts) et hors de cette story.
 */
describe('Y-FIX-02 critère 5 : premier ajout à moitié écrit (partialLastLine)', () => {
  it('iPhone : aucun enregistrement perdu ni publié deux fois, segment accepté par Rust, état à la tête de Rust, aucun message', async () => {
    const { a, b } = await joined(['Deuxième du lot', 'Troisième du lot']);
    b.folder.armFaults({ name: 'Y-FIX-02 critère 5', faults: [{ id: 'partial', op: 'write', file: `devices/${B_ID}/*/j-00000001.ctj`, nth: 1, effect: 'error', code: 'io', partialLastLine: true }] });
    await b.cycle();
    expect(b.folder.faultLog().map((f) => f.id)).toEqual(['partial']);
    b.folder.disarmFaults();
    await b.restart();
    let last = await b.cycle();
    if (!b.folder.fileNames(b.id).includes('state.ctx') || (await b.data.repos.sync.outboxCount()) > 0) last = await b.cycle();
    expect(await b.data.repos.sync.outboxCount()).toBe(0);
    expect(last.warnings ?? []).not.toContain('publish-blocked');
    expect(last.errorCode).toBeNull();
    expect(statusLine(last, b.clock.nowMs())).toContain('À jour');
    // Segment 1 tronqué (aucune ligne complète), lot entier publié une fois dans le segment 2 ouvert par `max + 1`.
    expect(segments(b).map((f) => f.slice(-14))).toEqual(['j-00000001.ctj', 'j-00000002.ctj']);
    const [cut, accepted] = segments(b) as [string, string];
    expect(b.folder.records(b.id, cut)).toEqual([]);
    const lines = b.folder.records(b.id, accepted);
    expect(lines).toHaveLength(1);
    for (const id of [T_ID, '7b000002-0000-4000-8000-bbbbbbbbbbbb', '7b000003-0000-4000-8000-bbbbbbbbbbbb']) expect(lines.join('').split(id)).toHaveLength(2);
    expect(await meta<{ segment: number; record: number }>(b, 'head')).toMatchObject({ segment: 2, record: 1 });
    // L'état publié porte la tête de Rust : relu par le PC (dossier recopié), accepté avec cette tête.
    syncFolders([a, b]);
    await a.cycle();
    expect((await a.data.repos.sync.getStates()).find((r) => r.deviceId === b.id)).toMatchObject({ headSegment: 2, headRecord: 1 });
  });
});

/** Rang de l'écriture de l'état dans le cycle qui reprend après l'arrêt `rank` (comptage sans arrêt, simulateur déterministe). */
async function recoveryStateRank(rank: number): Promise<number> {
  const { b } = await crashAt(rank);
  const probe = armCrash(b, null);
  let stateRank: number | null = null;
  const platform = b.platform as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = platform['writeState'] as (...args: unknown[]) => Promise<unknown>;
  platform['writeState'] = (...args) => {
    stateRank ??= probe.writes + 1;
    return real.apply(b.platform, args);
  };
  await b.cycle();
  probe.disarm();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  if (stateRank === null) throw new Error('aucun état écrit pendant la reprise');
  return stateRank;
}

describe('Y-FIX-02 critère 6 : arrêt pendant la reprise elle-même', () => {
  for (const offset of [0, 1, 2] as const) {
    const where = ['avant writeState', 'entre writeState et sa transaction', 'entre la transaction de l’état et celle de la reprise'][offset];
    it(`arrêt ${where as string} : résultat du critère 2, stateSeq croissant, aucun doublon`, async () => {
      const ranks = await writeRanks();
      const stateRank = await recoveryStateRank(ranks.append + 1);
      const { a, b, stateSeqs } = await crashAt(ranks.append + 1);
      const crash = armCrash(b, stateRank + offset);
      await b.cycle();
      expect(crash.crashed).toBe(true);
      crash.disarm();
      await b.restart();
      for (let i = 0; i < 2; i += 1) await b.cycle();
      expect(b.folder.fileNames(b.id)).toContain('state.ctx');
      expect(stateSeqs.length).toBeGreaterThanOrEqual(1);
      expect(stateSeqs).toEqual([...new Set(stateSeqs)].sort((x, y) => x - y));
      expect(await meta(b, 'inflight')).toBeNull();
      expect(await b.data.repos.sync.outboxCount()).toBe(0);
      expect(segments(b)).toHaveLength(1);
      expect(b.folder.records(b.id, segments(b)[0] as string)).toHaveLength(1);
      expect(await meta<{ segment: number; record: number }>(b, 'head')).toMatchObject({ segment: 1, record: 1 });
      await expectConverged(a, b);
    });
  }
});

describe('Y-FIX-02 critère 7 : échéance du cycle hide entre la transaction d’ajout et l’état', () => {
  it('le cycle suivant, avec une nouvelle échéance, publie state.ctx sans jamais lever publish-blocked', async () => {
    const { a, b } = await joined();
    let appended = false;
    const real = b.platform.appendJournal.bind(b.platform);
    const platform: SyncPlatform = {
      ...b.platform,
      appendJournal: async (input) => {
        const out = await real(input);
        appended = true;
        return out;
      },
    };
    phoneService(b, platform, (unit) => {
      if (unit === 'write-state' && appended) b.clock.advance(HIDE_SYNC_DEADLINE_MS);
    });
    await b.service.syncNow('hide', { deadlineAt: b.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });
    expect(appended).toBe(true);
    expect(events(b, 'cycle-interrupted').map((e) => e.detail)).toEqual([{ unit: 'write-state' }]);
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    appended = false;
    await b.service.syncNow('hide', { deadlineAt: b.clock.nowMs() + HIDE_SYNC_DEADLINE_MS });
    expect(b.folder.fileNames(b.id)).toContain('state.ctx');
    expect(b.service.status().warnings ?? []).not.toContain('publish-blocked');
    expect(events(b, 'publish-deferred')).toHaveLength(0);
    await expectConverged(a, b);
  });
});

describe('Y-FIX-02 contre-revue S3 : intention d’une autre époque pendant une borne de source local-head', () => {
  it('l’intention n’est ni résolue ni republiée ; l’état est publié par la tête locale', async () => {
    const ranks = await writeRanks();
    const { b, stateSeqs } = await crashAt(ranks.state);
    const head = await meta<{ hlc: string }>(b, 'head');
    // Intention d'une autre époque (reste d'avant un changement d'époque), même forme que celle de `publishOutbox`.
    const stale = { epoch: epochId(1, B_ID as DeviceId), segment: 1, expect: 0, count: 1, maxHlc: head?.hlc, entries: [] };
    await b.data.repos.sync.setMeta('inflight', JSON.stringify(stale));
    const result = await b.cycle();
    expect(events(b, 'inflight-resolved')).toHaveLength(0);
    expect(await meta(b, 'inflight')).toEqual(stale);
    expect(events(b, 'own-state-recovered').map((e) => e.detail)).toEqual([{ epoch: expect.any(String), source: 'local-head' }]);
    expect(stateSeqs).toEqual([1]);
    expect(segments(b)).toHaveLength(1);
    expect(result.warnings ?? []).not.toContain('publish-blocked');
  });
});

describe('Y-FIX-02 critère 9 : fichier que la trace n’explique pas', () => {
  // Revue B1 (option a) : l'intention est gardée tant que la publication est refusée ; aucun état n'est écrit, rien ne change d'un cycle à l'autre.
  it('intention gardée et stable, aucun état ni aucune publication, publish-blocked avec la cause unexplained-files à chaque cycle', async () => {
    const ranks = await writeRanks();
    const { b, stateSeqs } = await crashAt(ranks.append + 1);
    // Segment 2 déposé dans le dossier de l'iPhone (reste d'un tiers) : la trace dit 1.
    const dir = b.folder.devices.get(b.id);
    const epochDir = dir ? [...dir.epochs.values()][0] : undefined;
    const first = epochDir?.segments.get(1);
    if (!epochDir || !first) throw new Error('segment 1 absent');
    epochDir.segments.set(2, first);
    const before = segments(b);
    const inflight = await meta(b, 'inflight');
    const queued = await b.data.repos.sync.outboxCount();
    expect(inflight).not.toBeNull();
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const result = await b.cycle();
      expect(b.folder.fileNames(b.id), `cycle ${String(cycle)}`).not.toContain('state.ctx');
      expect(stateSeqs).toEqual([]);
      expect(await meta(b, 'inflight')).toEqual(inflight);
      expect(await b.data.repos.sync.outboxCount()).toBe(queued);
      expect(segments(b)).toEqual(before);
      expect(result.warnings).toContain('publish-blocked');
      expect(result.warnings).toContain('unexplained-files');
      expect(statusLine(result, b.clock.nowMs())).not.toContain('À jour');
    }
    expect(events(b, 'inflight-resolved')).toHaveLength(0);
    expect(events(b, 'publish-deferred').map((e) => e.detail)).toEqual([expect.objectContaining({ reason: 'unexplained-files', unexplained: 1 }), expect.objectContaining({ reason: 'unexplained-files', unexplained: 1 })]);
    expect(events(b, 'own-state-recovered')).toHaveLength(0);
  });
});

describe('Y-FIX-02 critère 11 : échec durable de l’état pendant la reprise, visible', () => {
  it('io puis state-mismatch pendant dix cycles : publish-blocked et sa cause à chaque cycle, jamais « À jour » ; le refus cesse : publié au cycle suivant', async () => {
    const ranks = await writeRanks();
    const { a, b } = await crashAt(ranks.state);
    let cycleNo = 0;
    let refusing = true;
    const real = b.platform.writeState.bind(b.platform);
    phoneService(b, {
      ...b.platform,
      writeState: (input) => (refusing ? Promise.reject(new SyncPlatformError(cycleNo <= 5 ? 'io' : 'state-mismatch')) : real(input)),
    });
    for (cycleNo = 1; cycleNo <= 10; cycleNo += 1) {
      await b.service.syncNow('manual');
      const s = b.service.status();
      expect(s.warnings, `cycle ${String(cycleNo)}`).toEqual(expect.arrayContaining(['publish-blocked', 'first-publication-state-refused']));
      expect(statusLine(s, b.clock.nowMs())).not.toContain('À jour');
      const banners = syncBannerFor<SyncDeviceStatus, SyncStatus>(s, NO_PERSISTED);
      expect(banners.troubles.map((x) => x.code)).toContain('publish-blocked');
      // Aucune intention en suspens (arrêt P3) : rien qui change d'un cycle à l'autre.
      expect(await meta(b, 'inflight')).toBeNull();
      expect(await meta<{ segment: number; record: number }>(b, 'head')).toMatchObject({ segment: 1, record: 1 });
    }
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    refusing = false;
    await b.service.syncNow('manual');
    const healed = b.service.status();
    expect(b.folder.fileNames(b.id)).toContain('state.ctx');
    expect(healed.warnings ?? []).not.toContain('publish-blocked');
    expect(healed.warnings ?? []).not.toContain('first-publication-state-refused');
    expect(statusLine(healed, b.clock.nowMs())).toContain('À jour');
    const reasons = events(b, 'publish-deferred').map((e) => e.detail.reason);
    expect(reasons).toHaveLength(10);
    expect(new Set(reasons)).toEqual(new Set(['first-publication-state-refused']));
    await expectConverged(a, b);
  });
});

describe('Y-FIX-02 critère 12 : journal sans contenu', () => {
  it('inflight-resolved, own-state-recovered et publish-deferred ne portent que des codes et des compteurs', async () => {
    const ranks = await writeRanks();
    const { b } = await crashAt(ranks.append + 1);
    const dir = b.folder.devices.get(b.id);
    const epochDir = dir ? [...dir.epochs.values()][0] : undefined;
    const first = epochDir?.segments.get(1);
    if (!epochDir || !first) throw new Error('segment 1 absent');
    epochDir.segments.set(2, first);
    await b.cycle();
    epochDir.segments.delete(2);
    await b.cycle();
    const allowed = new Set(['reason', 'source', 'appended', 'files', 'unexplained', 'ignored', 'acks', 'localSeq', 'epoch', 'state']);
    const watched = b.logger.entries.filter((e) => ['inflight-resolved', 'own-state-recovered', 'publish-deferred'].includes(e.event));
    expect(watched.map((e) => e.event)).toEqual(expect.arrayContaining(['inflight-resolved', 'publish-deferred']));
    for (const e of watched) for (const key of Object.keys(e.detail)) expect(allowed.has(key), `${e.event}.${key}`).toBe(true);
    const text = JSON.stringify(b.logger.entries);
    for (const needle of [T_TITLE, 'j-00000001.ctj', 'j-00000002.ctj', 'state.ctx']) expect(text).not.toContain(needle);
  });
});
