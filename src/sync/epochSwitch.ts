import type { ExportedRow, Repositories } from '../db/repositories';
import { PAGE_ROWS, parseEpochId, type DeviceAck, type EpochId, type ForgottenDevice, type PublishedDeviceState, type SyncField, type SyncOp } from '../domain/sync/format';
import { mustCarry } from '../domain/sync/epoch';
import { hlcDevice } from '../domain/sync/parse';
import { SYNC_TABLES, settingKeyScope, syncTable, type SyncTable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import { coversForgotten } from '../domain/sync/retention';
import { applyOps, type ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import { setSnapshotWait } from './forget';
import { guarded } from './guarded';
import { META, readJson, writeJson } from './meta';
import { ROW_REPUBLISH_FIELD } from './publisher';
import { positionAfterReplace, positionFromCover } from '../domain/sync/positions';
import { purgeRows } from './purge';
import { loadSnapshot, mergeSnapshot, replaceFromSnapshot, type LoadedSnapshot } from './snapshot';

/**
 * Passage à une époque plus récente sans perte (ADR 0011, section 9.1 ; Y-02 critère 14, Y-09 critère 9), sur chaque appareil B qui
 * la voit (restauration « Appliquer partout » d'un autre appareil, ou époques concurrentes) :
 *
 * (a) **matérialisation depuis la base locale** de B, par pages : chaque ligne dont un champ porte une horloge de B au-delà de
 *     `covers[B].hlc` (ce que l'ouvreur avait lu de B), ou un champ en attente dans la file ; chaque identifiant purgé par B au-delà de
 *     `covers[B]` ; le tout gardé dans `sync_parked` (motif `epoch-carry`, jamais abandonné) ;
 * (b) **remplacement** de la base par l'instantané qui ouvre l'époque (la version restaurée porte des hlc anciens et perdrait à la fusion) ;
 *     Y-11 (§9.1 b, réinitialisation) : **fusion** de la section 5.5 (mode `merge`), l'instantané contient tout ce que l'ouvreur a lu jusqu'aux
 *     têtes, rien n'est à imposer ; l'instantané d'ouverture doit alors couvrir chaque oublié retenu jusqu'à sa coupure (accusés de
 *     l'ancienne époque), sinon le changement attend de façon visible (`forgetSnapshotWait`, dette « changement d'époque ») ;
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
  /** Plus grand numéro de la file au début de (a) : (b) ne vide la file que jusqu'à lui. */
  readonly maxSeq: number;
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
  /** Peut écrire dans la base (écriture locale pendant le changement) ou lever (arrêt simulé). */
  afterStep?: (step: SwitchStep) => void | Promise<void>;
}

let testHooks: SwitchTestHooks = {};
export function setEpochSwitchTestHooks(hooks: SwitchTestHooks): void {
  testHooks = hooks;
}

/**
 * Instantané qui ouvre `target` : celui de l'ouvreur s'il est annoncé, sinon le plus récent annoncé dans `target`. Son propre état compte
 * (QA-2 : après une restauration antérieure à l'époque que cet appareil a lui-même ouverte, il est l'ouvreur et la seule source).
 */
function snapshotSource(target: EpochId, accepted: ReadonlyMap<DeviceId, PublishedDeviceState>, own: PublishedDeviceState | null): { deviceId: DeviceId; seq: number } | null {
  const opener = parseEpochId(target)?.opener;
  const states: [DeviceId, PublishedDeviceState][] = [...accepted.entries(), ...(own && !accepted.has(own.deviceId) ? [[own.deviceId, own] as [DeviceId, PublishedDeviceState]] : [])];
  const inTarget = states.filter(([, s]) => s.epoch === target && s.snapshot !== null);
  const chosen = inTarget.find(([id]) => id === opener) ?? inTarget.sort(([, a], [, b]) => ((a.snapshot?.endHlc ?? '') < (b.snapshot?.endHlc ?? '') ? -1 : 1))[0];
  return chosen ? { deviceId: chosen[0], seq: (chosen[1].snapshot as { seq: number }).seq } : null;
}

/** Ligne de la base → opération reportée (ligne complète, champs propres choisis par `isOwn`) ; null sans champ propre. */
function carriedOf(t: SyncTable, row: ExportedRow, isOwn: (name: string, hlc: Hlc) => boolean): CarriedOp | null {
  if (t.name === 'settings' && settingKeyScope(row.id) !== 'shared') return null;
  const fallback = row.clocks.get('*') ?? { hlc: row.hlc, base: null };
  const f: Record<string, SyncField> = {};
  const own: string[] = [];
  for (const col of t.columns) {
    const clock = row.clocks.get(col.name) ?? fallback;
    f[col.name] = [row.values.get(col.name) ?? null, clock.hlc, row.clocks.get(col.name)?.base ?? null];
    if (isOwn(col.name, clock.hlc)) own.push(col.name);
  }
  return own.length > 0 ? { t: t.name, id: row.id, at: row.updatedAt, f, own } : null;
}

/** Champs en attente d'une ligne : `'*'` et `ROW_REPUBLISH_FIELD` valent pour toutes les colonnes. */
const pendingHas = (pending: ReadonlySet<string>, name: string): boolean => pending.has(name) || pending.has('*') || pending.has(ROW_REPUBLISH_FIELD);

/**
 * (a) Matérialisation depuis la base locale, par pages de 500 lignes, une transaction par page. Le plus grand numéro de la file au
 * début de (a) est mémorisé (`maxSeq`) : seules les entrées jusqu'à lui seront vidées en (b) ; les écritures suivantes sont reportées
 * par `carryNewer` avant chaque transaction de remplacement.
 */
async function materialize(deps: SyncDeps, cover: DeviceAck | null, maxSeq: number): Promise<number> {
  const self = deps.deviceId;
  const { data } = deps;
  await data.transaction(async (repos) => {
    const old = await repos.sync.parked(['epoch-carry'], 0, 1_000_000);
    await repos.sync.removeParked(old.map((p) => p.id));
    await writeJson(repos, META.epochCarry, maxSeq);
  });
  const outbox = await data.repos.sync.readOutbox(undefined, 0);
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
        const pending = pendingFields.get(`${t.name}\u0000${row.id}`) ?? new Set<string>();
        const op = carriedOf(t, row, (name, hlc) => hlcDevice(hlc) === self && (mustCarry(hlc, self, cover) || pendingHas(pending, name)));
        if (op) ops.push(op);
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

/**
 * Report, en tête de **chaque** transaction de remplacement (b) et dans celle-ci, des écritures locales faites depuis le début de (a)
 * (numéros de file au-delà du dernier reporté) : sans lui, le remplacement les écraserait et le vidage de la file les oublierait. Le
 * dernier numéro reporté est mémorisé dans la même transaction (`sync_meta.epochCarry`).
 */
async function carryNewer(deps: SyncDeps, repos: Repositories): Promise<void> {
  const after = (await readJson<number>(repos, META.epochCarry)) ?? 0;
  const entries = await repos.sync.readOutbox(undefined, after);
  if (entries.length === 0) return;
  const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
  const byTable = new Map<SyncTable, Map<string, Set<string>>>();
  for (const e of entries) {
    const t = syncTable(e.table);
    if (!t) continue;
    const rows = byTable.get(t) ?? new Map<string, Set<string>>();
    rows.set(e.rowId, new Set([...(rows.get(e.rowId) ?? []), e.field]));
    byTable.set(t, rows);
  }
  let carried = 0;
  for (const [t, rowsFields] of byTable) {
    const rows = await repos.sync.readRowsWithClocks(t, [...rowsFields.keys()]);
    for (const [id, fields] of rowsFields) {
      const row = rows.get(id);
      if (!row) continue;
      const op = carriedOf(t, row, (name, hlc) => hlcDevice(hlc) === deps.deviceId && pendingHas(fields, name));
      if (!op) continue;
      await repos.sync.park('epoch-carry', t.name, id, maxOwn(op), JSON.stringify(op), now);
      carried += 1;
    }
  }
  await writeJson(repos, META.epochCarry, Math.max(after, ...entries.map((e) => e.seq)));
  if (carried > 0) deps.logger.log('epoch-carry-late', { rows: carried });
}

const maxOwn = (op: CarriedOp): Hlc => op.own.map((name) => (op.f[name] as SyncField)[1]).reduce((a, b) => (b > a ? b : a));

/** (c) Réapplication par la règle de hlc, remise dans la file (hlc d'origine), retrait des reports de la page. */
async function reapply(deps: SyncDeps): Promise<Map<string, Set<string>>> {
  const touched = new Map<string, Set<string>>();
  for (;;) {
    const page = await deps.data.repos.sync.parked(['epoch-carry'], 0, PAGE_ROWS);
    if (page.length === 0) break;
    const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
    // Horloge locale au-delà de tout ce qui est réappliqué (les écritures locales suivantes l'emportent toujours).
    let pageMax: Hlc | null = null;
    for (const parked of page) if (pageMax === null || parked.hlc > pageMax) pageMax = parked.hlc;
    for (const parked of page) for (const field of Object.values((JSON.parse(parked.op) as CarriedOp).f)) if (pageMax === null || field[1] > pageMax) pageMax = field[1];
    if (pageMax !== null) deps.hlc.receive(pageMax);
    await guarded(deps.data, async (repos) => {
      for (const parked of page) {
        const op = JSON.parse(parked.op) as CarriedOp;
        const t = syncTable(op.t);
        if (!t) continue;
        if (op.tomb !== undefined) {
          // Ligne présente : purgée avec ses rappels, sauf si elle a encore des enfants (écartée, journalisée) ; absente : trace seule.
          if ((await repos.sync.existingIds(t, [op.id])).has(op.id)) {
            const done = await purgeRows(repos, t, [{ id: op.id, deletedHlc: op.tomb }], now, deps.logger, { reattach: (table, ids) => ids.forEach((id) => addTouched(touched, table, id)) });
            for (const item of done.purged) addTouched(touched, t.name, item.id);
            for (const id of done.reminders) addTouched(touched, 'reminder', id);
          } else {
            await repos.sync.insertTombstones([{ table: t.name, rowId: op.id, deletedHlc: op.tomb }], now);
          }
          continue;
        }
        const existed = (await repos.sync.existingIds(t, [op.id])).has(op.id);
        // Ligne présente : seuls ses propres champs ; ligne absente : la ligne entière, pour pouvoir la recréer.
        const fields = Object.entries(op.f).filter(([name]) => !existed || op.own.includes(name));
        const syncOp: SyncOp = { t: op.t, id: op.id, at: op.at, f: new Map(fields) };
        await applyOps(repos, [syncOp], { localSv: deps.sv, remoteSv: deps.sv, now, knows: () => true, logger: deps.logger, noPark: true });
        if (!(await repos.sync.existingIds(t, [op.id])).has(op.id)) continue;
        if (!existed) {
          // Ligne recréée : la nouvelle époque ne la connaît pas ; elle est republiée **entière** (champs des autres appareils compris,
          // avec leurs horloges), sinon les autres appareils ne recevraient que ses champs propres et la mettraient de côté pour toujours.
          await repos.sync.addOutbox([{ table: t.name, rowId: op.id, field: ROW_REPUBLISH_FIELD }]);
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

/**
 * Y-11 : changement d'époque d'une réinitialisation (`merge`) : fusion au lieu du remplacement (§9.1 b) ; `coverage` : liste maître des
 * oublis et états de l'**ancienne** époque (leurs accusés fixent la coupure de chaque oublié retenu), pour vérifier l'instantané d'ouverture.
 */
export interface SwitchOptions {
  readonly mode: 'replace' | 'merge';
  readonly knows?: ApplyContext['knows'];
  readonly coverage?: { readonly master: readonly ForgottenDevice[]; readonly ackers: readonly PublishedDeviceState[] };
}

/** Passe à l'époque `target` ; reprend à l'étape mémorisée. `uncovered` : instantané d'ouverture qui ne couvre pas un oublié retenu (Y-11). */
export async function switchEpoch(
  deps: SyncDeps,
  target: EpochId,
  accepted: ReadonlyMap<DeviceId, PublishedDeviceState>,
  ownState: PublishedDeviceState | null,
  onRemoteChanges: (touched: ReadonlyMap<string, ReadonlySet<string>>) => void,
  options: SwitchOptions = { mode: 'replace' },
): Promise<'done' | 'cloud-pending' | 'error' | 'clock-ahead' | 'uncovered'> {
  const repos: Repositories = deps.data.repos;
  let progress = await readJson<SwitchProgress>(repos, META.epochSwitch);
  if (!progress || progress.target !== target) {
    const from = snapshotSource(target, accepted, ownState);
    if (!from) return 'cloud-pending';
    // Y-11 (dette « changement d'époque », piste appliquée) : l'instantané d'ouverture d'une réinitialisation porte, dans `covers`, la position
    // de l'ouvreur sur chaque oublié retenu (ancienne époque) ; il doit atteindre la coupure, sinon le changement attend, de façon visible.
    if (options.mode === 'merge' && options.coverage && options.coverage.master.length > 0) {
      const loaded = await loadSnapshot(deps, from.deviceId, target, from.seq);
      if (loaded === 'cloud-pending') return 'cloud-pending';
      if (!loaded) return 'error';
      const uncovered = coversForgotten(loaded.end.covers, options.coverage.master, options.coverage.ackers);
      if (uncovered !== null) {
        await setSnapshotWait(deps, uncovered);
        deps.logger.log('epoch-switch-uncovered', { target, device: uncovered });
        return 'uncovered';
      }
      await setSnapshotWait(deps, null);
    }
    progress = { target, step: 'a', from, maxSeq: await repos.sync.maxOutboxSeq() };
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
    const carried = await materialize(deps, loaded.end.covers.get(deps.deviceId) ?? null, progress.maxSeq);
    deps.logger.log('epoch-carry', { target, rows: carried });
    await advance('b');
    await testHooks.afterStep?.('a');
  }
  if (progress.step === 'b') {
    const loaded = await load();
    if (loaded === 'cloud-pending') return 'cloud-pending';
    if (!loaded) return 'error';
    const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
    // Y-11 : réinitialisation : fusion (la base locale et les écritures faites pendant le changement sont gardées par la règle de hlc).
    const result =
      options.mode === 'merge'
        ? await mergeSnapshot(deps, loaded, { localSv: deps.sv, remoteSv: loaded.end.sv, now, knows: options.knows ?? (() => false), logger: deps.logger })
        : await replaceFromSnapshot(deps, loaded, (tx) => carryNewer(deps, tx));
    if (result === 'clock-ahead') {
      // Instantané d'ouverture trop en avance (section 4.4) : rien n'a été remplacé ; l'ouvreur est signalé, le changement attend.
      await repos.sync.saveState(progress.from.deviceId, { status: 'clock-ahead' });
      return 'clock-ahead';
    }
    // File vidée jusqu'au numéro mémorisé en (a) seulement : les écritures suivantes ont été reportées et restent dans la file.
    await repos.sync.clearOutbox(progress.maxSeq);
    onRemoteChanges(result.touched);
    await advance('c');
    await testHooks.afterStep?.('b');
  }
  if (progress.step === 'c') {
    const touched = await reapply(deps);
    if (touched.size > 0) onRemoteChanges(touched);
    await advance('d');
    await testHooks.afterStep?.('c');
  }
  // (d) Nouvelle époque : tête vide ; la publication suit dans le cycle.
  // Y-TECH-01 : en remplacement, la position sur chaque autre appareil est celle que la base remplacée contient (`positionAfterReplace`).
  // Y-TECH-02 (ADR 0011 §21 point 4) : `covers` de l'instantané d'ouverture chargé dans les deux modes ; en fusion, il donne la position
  // d'une ligne sans époque (`positionFromCover`).
  const loaded = await load();
  if (loaded === 'cloud-pending') return 'cloud-pending';
  if (!loaded) return 'error';
  const covers: ReadonlyMap<DeviceId, DeviceAck> = loaded.end.covers;
  await deps.data.transaction(async (tx) => {
    for (const row of await tx.sync.getStates()) {
      // §18.14 « accusés figés à l'import » (seconde revue, bloquant) : dans une réinitialisation (fusion), la position en `n` de tout
      // appareil encore en `n` est gardée ; elle ne passe à `n+1` qu'à sa première lecture dans `n+1` (jamais d'accusé « début de
      // l'époque visée » sur un appareil qui n'y a rien publié).
      const keep = !row.isSelf && row.epoch !== null && row.epoch !== target && options.mode === 'merge';
      if (keep) continue;
      // Y-TECH-02 (§21 point 4) : en fusion, ligne d'un autre appareil sans époque (la base ne contenait rien de lui) : elle en contient
      // maintenant `covers` de l'instantané d'ouverture, ou rien ; « l'accusé suit la base », jamais {`target`, 0, 0}.
      if (!row.isSelf && row.epoch === null && options.mode === 'merge') {
        await tx.sync.saveState(row.deviceId, positionFromCover(covers.get(row.deviceId as DeviceId), target, false, row));
        continue;
      }
      // Remplacement (ADR §9.1 (d), §20 point 3) : l'accusé suit la base, oubliés retenus et terminés compris ; position
      // couverte par l'instantané (accusé hérité, §14.2), ou aucune ; jamais {`target`, 0, 0} sur un appareil qui n'y a rien publié.
      const replaced = !row.isSelf && options.mode === 'replace';
      await tx.sync.saveState(row.deviceId, replaced ? positionAfterReplace(row.stateEpoch, covers.get(row.deviceId as DeviceId), target) : { epoch: target, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
    }
    await writeJson(tx, META.epoch, target);
    await writeJson(tx, META.head, { epoch: target, segment: 0, record: 0, hlc: null, stateSeq: 0 } satisfies DeviceAck);
    await writeJson(tx, META.snapshot, null);
    await writeJson(tx, META.segments, null);
    await writeJson(tx, META.resume, null);
    await writeJson(tx, META.epochSwitch, null);
    await writeJson(tx, META.epochCarry, null);
  });
  deps.logger.log('epoch-switched', { target });
  return 'done';
}
