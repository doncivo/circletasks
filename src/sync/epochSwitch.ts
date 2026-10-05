import type { ExportedRow, Repositories } from '../db/repositories';
import { PAGE_ROWS, parseEpochId, type DeviceAck, type EpochId, type PublishedDeviceState, type SyncField, type SyncOp } from '../domain/sync/format';
import { mustCarry } from '../domain/sync/epoch';
import { hlcDevice } from '../domain/sync/parse';
import { SYNC_TABLES, settingKeyScope, syncTable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import { applyOps } from './apply';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';
import { META, readJson, writeJson } from './meta';
import { loadSnapshot, replaceFromSnapshot, type LoadedSnapshot } from './snapshot';

/**
 * Passage à une époque plus récente sans perte (ADR 0011, section 9.1 ; Y-02 critère 14, Y-09 critère 9), sur chaque appareil B qui
 * la voit (restauration « Appliquer partout » d'un autre appareil, ou époques concurrentes) :
 *
 * (a) **matérialisation depuis la base locale** de B, par pages : chaque ligne dont un champ porte une horloge de B au-delà de
 *     `covers[B].hlc` (ce que l'ouvreur avait lu de B), ou un champ en attente dans la file ; chaque identifiant purgé par B au-delà de
 *     `covers[B]` ; le tout gardé dans `sync_parked` (motif `epoch-carry`, jamais abandonné) ;
 * (b) **remplacement** de la base par l'instantané qui ouvre l'époque (la version restaurée porte des hlc anciens et perdrait à la fusion) ;
 * (c) **réapplication** des opérations de (a) par la règle de hlc, remise dans la file avec leurs hlc d'origine ;
 * (d) la publication ordinaire du cycle (triée par hlc croissant) les republie avant toute nouvelle écriture.
 *
 * L'étape en cours est mémorisée (`sync_meta.epochSwitch`) : un arrêt reprend à l'étape interrompue (chaque étape est idempotente).
 * Règle confirmée par Ali : les écritures de B que l'ouvreur avait déjà lues sont remplacées ; celles qu'il n'avait jamais lues et les
 * écritures non publiées sont gardées.
 */

export type SwitchStep = 'a' | 'b' | 'c' | 'd';

interface SwitchProgress {
  readonly target: EpochId;
  readonly step: SwitchStep;
  readonly from: { readonly deviceId: DeviceId; readonly seq: number };
}

/** Opération reportée : ligne complète (pour pouvoir la recréer) et champs écrits par cet appareil ; ou identifiant purgé. */
interface CarriedOp {
  readonly t: string;
  readonly id: string;
  readonly at: IsoDateTime;
  readonly f: Record<string, SyncField>;
  readonly own: readonly string[];
  readonly tomb?: Hlc;
}

/** Arrêt simulé entre deux étapes (tests de reprise). */
export interface SwitchTestHooks {
  afterStep?: (step: SwitchStep) => void;
}

let testHooks: SwitchTestHooks = {};
export function setEpochSwitchTestHooks(hooks: SwitchTestHooks): void {
  testHooks = hooks;
}

function snapshotSource(target: EpochId, accepted: ReadonlyMap<DeviceId, PublishedDeviceState>): { deviceId: DeviceId; seq: number } | null {
  const opener = parseEpochId(target)?.opener;
  const inTarget = [...accepted.entries()].filter(([, s]) => s.epoch === target && s.snapshot !== null);
  const chosen = inTarget.find(([id]) => id === opener) ?? inTarget.sort(([, a], [, b]) => ((a.snapshot?.endHlc ?? '') < (b.snapshot?.endHlc ?? '') ? -1 : 1))[0];
  return chosen ? { deviceId: chosen[0], seq: (chosen[1].snapshot as { seq: number }).seq } : null;
}

/** (a) Matérialisation depuis la base locale, par pages de 500 lignes, une transaction par page. */
async function materialize(deps: SyncDeps, cover: DeviceAck | null): Promise<number> {
  const self = deps.deviceId;
  const { data } = deps;
  await data.transaction(async (repos) => {
    const old = await repos.sync.parked(['epoch-carry'], 0, 1_000_000);
    await repos.sync.removeParked(old.map((p) => p.id));
  });
  const outbox = await data.repos.sync.readOutbox();
  const pendingFields = new Map<string, Set<string>>();
  for (const e of outbox) {
    const key = `${e.table}\u0000${e.rowId}`;
    pendingFields.set(key, new Set([...(pendingFields.get(key) ?? []), e.field]));
  }
  const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
  let carried = 0;
  for (const t of SYNC_TABLES) {
    let after: string | null = null;
    for (;;) {
      const rows: ExportedRow[] = await data.repos.sync.exportRows(t, after, PAGE_ROWS);
      if (rows.length === 0) break;
      after = (rows.at(-1) as ExportedRow).id;
      const ops: CarriedOp[] = [];
      for (const row of rows) {
        if (t.name === 'settings' && settingKeyScope(row.id) !== 'shared') continue;
        const fallback = row.clocks.get('*') ?? { hlc: row.hlc, base: null };
        const pending = pendingFields.get(`${t.name}\u0000${row.id}`) ?? new Set<string>();
        const f: Record<string, SyncField> = {};
        const own: string[] = [];
        let max: Hlc | null = null;
        for (const col of t.columns) {
          const clock = row.clocks.get(col.name) ?? fallback;
          f[col.name] = [row.values.get(col.name) ?? null, clock.hlc, row.clocks.get(col.name)?.base ?? null];
          const mine = hlcDevice(clock.hlc) === self;
          if (mine && (mustCarry(clock.hlc, self, cover) || pending.has(col.name) || pending.has('*'))) {
            own.push(col.name);
            if (max === null || clock.hlc > max) max = clock.hlc;
          }
        }
        if (own.length > 0 && max !== null) ops.push({ t: t.name, id: row.id, at: row.updatedAt, f, own });
      }
      if (ops.length > 0) {
        await data.transaction(async (repos) => {
          for (const op of ops) await repos.sync.park('epoch-carry', op.t, op.id, maxOwn(op), JSON.stringify(op), now);
        });
        carried += ops.length;
      }
    }
  }
  // Identifiants purgés par cet appareil au-delà de ce que l'ouvreur avait lu (sinon ils renaîtraient de l'instantané restauré).
  let afterTomb: { table: string; rowId: string } | null = null;
  for (;;) {
    const tombs = await data.repos.sync.exportTombstones(afterTomb, PAGE_ROWS);
    if (tombs.length === 0) break;
    const last = tombs.at(-1) as { table: string; rowId: string };
    afterTomb = { table: last.table, rowId: last.rowId };
    const mine = tombs.filter((tomb) => mustCarry(tomb.deletedHlc, self, cover));
    if (mine.length === 0) continue;
    await data.transaction(async (repos) => {
      for (const tomb of mine) {
        const op: CarriedOp = { t: tomb.table, id: tomb.rowId, at: now, f: {}, own: [], tomb: tomb.deletedHlc };
        await repos.sync.park('epoch-carry', tomb.table, tomb.rowId, tomb.deletedHlc, JSON.stringify(op), now);
      }
    });
    carried += mine.length;
  }
  return carried;
}

const maxOwn = (op: CarriedOp): Hlc => op.own.map((name) => (op.f[name] as SyncField)[1]).reduce((a, b) => (b > a ? b : a));

/** (c) Réapplication par la règle de hlc, remise dans la file (hlc d'origine), retrait des reports de la page. */
async function reapply(deps: SyncDeps): Promise<Map<string, Set<string>>> {
  const touched = new Map<string, Set<string>>();
  for (;;) {
    const page = await deps.data.repos.sync.parked(['epoch-carry'], 0, PAGE_ROWS);
    if (page.length === 0) break;
    const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
    await guarded(deps.data, async (repos) => {
      for (const parked of page) {
        const op = JSON.parse(parked.op) as CarriedOp;
        const t = syncTable(op.t);
        if (!t) continue;
        if (op.tomb !== undefined) {
          await repos.sync.insertTombstones([{ table: t.name, rowId: op.id, deletedHlc: op.tomb }], now);
          if (t.name === 'calendar_account') await repos.sync.deleteExternalEventsOf([op.id]);
          await repos.sync.deleteRows(t, [op.id]);
          addTouched(touched, t.name, op.id);
          continue;
        }
        const existed = (await repos.sync.existingIds(t, [op.id])).has(op.id);
        // Ligne présente : seuls ses propres champs ; ligne absente : la ligne entière, pour pouvoir la recréer.
        const fields = Object.entries(op.f).filter(([name]) => !existed || op.own.includes(name));
        const syncOp: SyncOp = { t: op.t, id: op.id, at: op.at, f: new Map(fields) };
        await applyOps(repos, [syncOp], { localSv: deps.sv, remoteSv: deps.sv, now, knows: () => true, logger: deps.logger, noPark: true });
        if (!(await repos.sync.existingIds(t, [op.id])).has(op.id)) continue;
        if (!existed) {
          await repos.sync.addOutbox([{ table: t.name, rowId: op.id, field: '*' }]);
        } else {
          const clocks = (await repos.sync.readClocks(t, [op.id])).get(op.id) ?? new Map();
          const row = (await repos.sync.readRows(t, [op.id])).get(op.id);
          const keep = op.own.filter((name) => (clocks.get(name) ?? clocks.get('*') ?? { hlc: row?.hlc }).hlc === (op.f[name] as SyncField)[1]);
          await repos.sync.addOutbox(keep.map((field) => ({ table: t.name, rowId: op.id, field })));
        }
        addTouched(touched, t.name, op.id);
      }
      await repos.sync.removeParked(page.map((p) => p.id));
    });
  }
  return touched;
}

function addTouched(touched: Map<string, Set<string>>, table: string, id: string): void {
  touched.set(table, new Set([...(touched.get(table) ?? []), id]));
}

/** Passe à l'époque `target` ; reprend à l'étape mémorisée. */
export async function switchEpoch(
  deps: SyncDeps,
  target: EpochId,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  _ownState: PublishedDeviceState | null,
  onRemoteChanges: (touched: ReadonlyMap<string, ReadonlySet<string>>) => void,
): Promise<'done' | 'cloud-pending' | 'error'> {
  const repos: Repositories = deps.data.repos;
  let progress = await readJson<SwitchProgress>(repos, META.epochSwitch);
  if (!progress || progress.target !== target) {
    const from = snapshotSource(target, accepted);
    if (!from) return 'cloud-pending';
    progress = { target, step: 'a', from };
    await writeJson(repos, META.epochSwitch, progress);
  }
  let snapshot: LoadedSnapshot | null = null;
  const load = async (): Promise<LoadedSnapshot | 'cloud-pending' | null> => {
    if (snapshot) return snapshot;
    const loaded = await loadSnapshot(deps, (progress as SwitchProgress).from.deviceId, target, (progress as SwitchProgress).from.seq);
    if (loaded && loaded !== 'cloud-pending') snapshot = loaded;
    return loaded;
  };
  const advance = async (step: SwitchStep): Promise<void> => {
    progress = { ...(progress as SwitchProgress), step };
    await writeJson(repos, META.epochSwitch, progress);
  };

  if (progress.step === 'a') {
    const loaded = await load();
    if (loaded === 'cloud-pending') return 'cloud-pending';
    if (!loaded) return 'error';
    const carried = await materialize(deps, loaded.end.covers.get(deps.deviceId) ?? null);
    deps.logger.log('epoch-carry', { target, rows: carried });
    await advance('b');
    testHooks.afterStep?.('a');
  }
  if (progress.step === 'b') {
    const loaded = await load();
    if (loaded === 'cloud-pending') return 'cloud-pending';
    if (!loaded) return 'error';
    const result = await replaceFromSnapshot(deps, loaded);
    await repos.sync.clearOutbox();
    onRemoteChanges(result.touched);
    await advance('c');
    testHooks.afterStep?.('b');
  }
  if (progress.step === 'c') {
    const touched = await reapply(deps);
    if (touched.size > 0) onRemoteChanges(touched);
    await advance('d');
    testHooks.afterStep?.('c');
  }
  // (d) Nouvelle époque : tête vide, curseurs de tous les appareils au début de l'époque ; la publication suit dans le cycle.
  await deps.data.transaction(async (tx) => {
    for (const row of await tx.sync.getStates()) await tx.sync.saveState(row.deviceId, { epoch: target, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
    await writeJson(tx, META.epoch, target);
    await writeJson(tx, META.head, { epoch: target, segment: 0, record: 0, hlc: null, stateSeq: 0 } satisfies DeviceAck);
    await writeJson(tx, META.snapshot, null);
    await writeJson(tx, META.segments, null);
    await writeJson(tx, META.resume, null);
    await writeJson(tx, META.epochSwitch, null);
  });
  deps.logger.log('epoch-switched', { target });
  return 'done';
}
