import type { ExportedRow, Repositories } from '../db/repositories';
import { PAGE_ROWS, parseEpochId, type DeviceAck, type EpochId, type ForgottenDevice, type PublishedDeviceState, type SyncField, type SyncOp } from '../domain/sync/format';
import { hlcDevice } from '../domain/sync/parse';
import { SYNC_TABLES, settingKeyScope, syncTable, tableRank, type SyncTable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import { coversForgotten } from '../domain/sync/retention';
import { EPOCH_CARRY_HELD_EVENT, EPOCH_CARRY_NOTICE_META, EPOCH_CARRY_REATTACHED_EVENT, addToEpochCarryNotice, carryLabel, carryParentVerdict, countByLink, parseEpochCarryNotice, type EpochCarryNoticeItem } from '../domain/sync/epochCarryNotice';
import {
  EMPTY_CARRY_REPORT_BODY,
  EPOCH_CARRY_REPORT_FAILED_EVENT,
  EPOCH_CARRY_REPORT_FAILED_META,
  EPOCH_CARRY_REPORT_KEEP,
  addCarriedCount,
  addNamed,
  carryCause,
  carryReportBanner,
  carryReportLabel,
  classifyCarriedRow,
  noticeItemsNotReported,
  parentItemsOf,
  type CarriedOpCount,
  type CarryRowState,
  type EpochCarryMode,
  type EpochCarryNamedItem,
  type EpochCarryParentItem,
  type EpochCarryReportBody,
  type EpochCarryReportHead,
} from '../domain/sync/epochCarryReport';
import { applyOps, type ApplyContext, type CarryPolicy } from './apply';
import { markEpochCarryNoticeFailure } from './carryNoticeState';
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
 * (a) **matérialisation depuis la base locale** de B, par pages, selon la règle de report validée par Ali le 2026-10-17 (option B,
 *     ADR 0011 §24 point 6, §26) : survit tout ce que l'ouvreur `O` n'avait pas lu, sauf ses propres écritures et celles d'un appareil
 *     oublié. B retient chaque ligne dont un champ a pour auteur un appareil `X ≠ O`, `X` non oublié, avec un hlc au-delà de
 *     `covers[X].hlc` (ce que l'ouvreur avait lu de `X` ; `X` = B compris, mais aussi tout tiers non oublié, par exemple l'ancien PC
 *     encore associé), ou un champ propre en attente dans la file ; chaque identifiant purgé dont l'auteur vérifie la même règle ; le tout
 *     gardé dans `sync_parked` (motif `epoch-carry`, jamais abandonné) ;
 * (b) **remplacement** de la base par l'instantané qui ouvre l'époque (la version restaurée porte des hlc anciens et perdrait à la fusion) ;
 *     Y-11 (§9.1 b, réinitialisation) : **fusion** de la section 5.5 (mode `merge`), l'instantané contient tout ce que l'ouvreur a lu jusqu'aux
 *     têtes, rien n'est à imposer ; l'instantané d'ouverture doit alors couvrir chaque oublié retenu jusqu'à sa coupure (accusés de
 *     l'ancienne époque), sinon le changement attend de façon visible (`forgetSnapshotWait`, dette « changement d'époque ») ;
 * (c) **réapplication** des opérations de (a) par la règle de hlc, remise dans la file avec leurs hlc d'origine ;
 * (d) la publication ordinaire du cycle (triée par hlc croissant) les republie avant toute nouvelle écriture.
 *
 * L'étape en cours est mémorisée (`sync_meta.epochSwitch`) : un arrêt reprend à l'étape interrompue (chaque étape est idempotente).
 * Règle validée par Ali (2026-10-05 pour la restauration, 2026-10-17 pour tous les auteurs, option B) : les écritures que l'ouvreur
 * avait déjà lues sont remplacées ; celles qu'il n'avait jamais lues, de n'importe quel appareil non oublié autre que lui, et les
 * écritures non publiées sont gardées. Le report rétablit, il n'efface jamais (limite connue et compte rendu visible : Y-TECH-05).
 */

export type SwitchStep = 'a' | 'b' | 'c' | 'd';

interface SwitchProgress {
  readonly target: EpochId;
  readonly step: SwitchStep;
  readonly from: { readonly deviceId: DeviceId; readonly seq: number };
  /** Plus grand numéro de la file au début de (a) : (b) ne vide la file que jusqu'à lui. */
  readonly maxSeq: number;
  /** Y-TECH-05 : compte rendu de ce report, créé dans la première page de (c) ou dans (d) (null : création impossible, échec journalisé et visible). */
  readonly report?: number | null;
}

/** Opération reportée : ligne complète (pour pouvoir la recréer) et champs écrits par cet appareil ; ou identifiant purgé. */
interface CarriedOp {
  readonly t: string;
  readonly id: string;
  readonly at: IsoDateTime;
  readonly f: Record<string, SyncField>;
  readonly own: readonly string[];
  readonly tomb?: Hlc;
  /** Y-TECH-05 : reporté par `carryNewer` (écriture locale faite pendant le changement) : compté à part dans le compte rendu. */
  readonly late?: 1;
}

/** Arrêt simulé entre deux étapes (tests de reprise). */
export interface SwitchTestHooks {
  /** Peut écrire dans la base (écriture locale pendant le changement) ou lever (arrêt simulé). */
  afterStep?: (step: SwitchStep) => void | Promise<void>;
  /** Y-TECH-05 (critère 25) : classement remplacé (épreuve de détection du banc). */
  classify?: typeof classifyCarriedRow;
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

/**
 * Y-IOS-02 (point de contrôle 0.2.3, étape 4) : abandon d'une époque orpheline (ouverte, jamais publiée) : chaque ligne qui porte un champ
 * écrit par cet appareil est remise **entière** dans la file de publication (`ROW_REPUBLISH_FIELD`, hlc d'origine gardés), car la file avait
 * été vidée à l'ouverture de l'époque (ses lignes ne vivaient que dans l'instantané orphelin). Rien n'est supprimé ni modifié localement.
 */
export async function queueOwnRowsForRepublish(deps: SyncDeps): Promise<number> {
  let queued = 0;
  // Idempotent (arrêt puis reprise) : une ligne déjà en file en ligne entière n'est pas ajoutée une seconde fois.
  const already = new Set((await deps.data.repos.sync.readOutbox(undefined, 0)).filter((e) => e.field === ROW_REPUBLISH_FIELD).map((e) => `${e.table}|${e.rowId}`));
  for (const t of SYNC_TABLES) {
    let after: string | null = null;
    for (;;) {
      const rows: ExportedRow[] = await deps.data.repos.sync.exportRows(t, after, PAGE_ROWS);
      if (rows.length === 0) break;
      after = (rows.at(-1) as ExportedRow).id;
      // Lignes dont une horloge porte le `device_id` de cet appareil (les lignes de l'amorce, `SEED`, sont identiques partout et n'en ont pas) ;
      // les lignes supprimées (`deleted_at`) sont republiées comme telles. Une trace purgée (`sync_tombstone`) n'a aucune forme dans le
      // journal : chaque appareil purge de son côté à l'échéance (section 7), la file ne peut pas la porter.
      const mine = rows.filter((row) => !already.has(`${t.name}|${row.id}`) && carriedOf(t, row, (_name, hlc) => hlcDevice(hlc) === deps.deviceId) !== null);
      if (mine.length === 0) continue;
      await deps.data.transaction(async (repos) => {
        await repos.sync.addOutbox(mine.map((row) => ({ table: t.name, rowId: row.id, field: ROW_REPUBLISH_FIELD })));
      });
      queued += mine.length;
    }
  }
  return queued;
}

/** Champs en attente d'une ligne : `'*'` et `ROW_REPUBLISH_FIELD` valent pour toutes les colonnes. */
const pendingHas = (pending: ReadonlySet<string>, name: string): boolean => pending.has(name) || pending.has('*') || pending.has(ROW_REPUBLISH_FIELD);

/**
 * (a) Matérialisation depuis la base locale, par pages de 500 lignes, une transaction par page. Le plus grand numéro de la file au
 * début de (a) est mémorisé (`maxSeq`) : seules les entrées jusqu'à lui seront vidées en (b) ; les écritures suivantes sont reportées
 * par `carryNewer` avant chaque transaction de remplacement.
 */
async function materialize(deps: SyncDeps, covers: ReadonlyMap<DeviceId, DeviceAck>, maxSeq: number, opener: DeviceId, forgotten: ReadonlySet<DeviceId>): Promise<number> {
  const self = deps.deviceId;
  /**
   * ADR 0011 §24 point 6 : survit au changement d'époque tout ce que l'ouvreur `O` n'avait pas lu, sauf ses propres écritures et celles d'un
   * appareil oublié. Un champ (suppression comprise) ou une trace purgée d'auteur `X` est reporté si `X ≠ O`, `X` non oublié et
   * hlc > `covers[X].hlc` de l'instantané d'ouverture (entrée absente ou sans hlc : tout ce que cet appareil détient de `X`).
   */
  const carries = (hlc: Hlc): boolean => {
    const author = hlcDevice(hlc) as DeviceId;
    if (author === opener || forgotten.has(author)) return false;
    const read = covers.get(author);
    return read === undefined || read.hlc === null || hlc > read.hlc;
  };
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
        const op = carriedOf(t, row, (name, hlc) => carries(hlc) || (hlcDevice(hlc) === self && pendingHas(pending, name)));
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
    const mine = tombs.filter((tomb) => carries(tomb.deletedHlc));
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
  // Y-FIX-04 (critère 4) : parents avant enfants (ordre du catalogue), comme `materialize` : `reapply` lit `sync_parked` par identifiant
  // croissant, un parent reporté ici doit donc être parqué avant son enfant, sinon l'enfant le croirait remplacé (rattaché à tort).
  for (const [t, rowsFields] of [...byTable].sort(([a], [b]) => tableRank(a.name) - tableRank(b.name))) {
    const rows = await repos.sync.readRowsWithClocks(t, [...rowsFields.keys()]);
    for (const [id, fields] of rowsFields) {
      const row = rows.get(id);
      if (!row) continue;
      const op = carriedOf(t, row, (name, hlc) => hlcDevice(hlc) === deps.deviceId && pendingHas(fields, name));
      if (!op) continue;
      await repos.sync.park('epoch-carry', t.name, id, maxOwn(op), JSON.stringify({ ...op, late: 1 }), now);
      carried += 1;
    }
  }
  await writeJson(repos, META.epochCarry, Math.max(after, ...entries.map((e) => e.seq)));
  if (carried > 0) deps.logger.log('epoch-carry-late', { rows: carried });
}

const maxOwn = (op: CarriedOp): Hlc => op.own.map((name) => (op.f[name] as SyncField)[1]).reduce((a, b) => (b > a ? b : a));

/**
 * Y-FIX-04 (§28) : notice locale complétée dans la transaction de la page (`sync_meta.epochCarryNotice`, jamais publiée). Une écriture
 * refusée pour une autre cause ne bloque pas le report (les données passent avant leur compte rendu) : journalisée, et l'avertissement
 * l'indicateur `carryNoticeState.ts` lève `carry-report` (Y-TECH-05), jamais muet. **Disque plein ou erreur d'entrée-sortie** (`SQLITE_FULL`,
 * `SQLITE_IOERR`) : SQLite peut avoir annulé toute la transaction ; l'erreur est relancée, la page est annulée entière (reports compris)
 * et l'étape (c) reprend au cycle suivant : jamais un `removeParked` hors transaction.
 */
async function recordCarryNotice(deps: SyncDeps, repos: Repositories, epoch: EpochId, at: IsoDateTime, reattached: readonly EpochCarryNoticeItem[], held: readonly EpochCarryNoticeItem[]): Promise<void> {
  try {
    const raw = await repos.sync.getMeta(EPOCH_CARRY_NOTICE_META);
    const previous = parseEpochCarryNotice(raw);
    if (raw !== null && previous === null) deps.logger.log('epoch-carry-notice-unreadable', {});
    await repos.sync.setMeta(EPOCH_CARRY_NOTICE_META, JSON.stringify(addToEpochCarryNotice(previous, { epoch, at, reattached, held })));
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    deps.logger.log('epoch-carry-notice-failed', { code: error instanceof Error ? error.name : 'unknown' });
    markEpochCarryNoticeFailure();
  }
}

/** Disque plein ou erreur d'entrée-sortie de SQLite (message brut, ou cause d'une `DbError` du driver). */
export function isStorageFailure(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; e = e.cause, depth += 1) {
    if (/SQLITE_FULL|SQLITE_IOERR|database or disk is full|disk I\/O error/i.test(e.message)) return true;
  }
  return false;
}

/**
 * Règle du report pour un parent remplacé (`carryParentVerdict`, tirée du catalogue) et relevé des items de la notice : espace et libellé
 * local pris dans la ligne reportée (`op.f` porte toutes ses colonnes) ; un même lien n'est relevé qu'une fois par ligne.
 */
function carryPolicy(op: CarriedOp, reattached: EpochCarryNoticeItem[], held: EpochCarryNoticeItem[]): CarryPolicy {
  const values = new Map(Object.entries(op.f).map(([name, field]) => [name, field[0]]));
  return {
    replaced(t, id, column, parentId, hlc) {
      const detach = carryParentVerdict(t, column, false) === 'detach';
      const list = detach ? reattached : held;
      if (!list.some((item) => item.table === t.name && item.rowId === id && item.column === column)) {
        const space = values.get('space_id');
        list.push({ table: t.name, rowId: id, column, parentId, space: typeof space === 'string' ? space : null, label: carryLabel(values), hlc: hlc ?? (op.f[column] as SyncField | undefined)?.[1] ?? maxOwn(op) });
      }
      return detach;
    },
  };
}

/**
 * (c) Réapplication par la règle de hlc, remise dans la file (hlc d'origine), retrait des reports de la page.
 * Y-FIX-04 (B4, §28) : mode `carry` d'`applyOps` : une ligne dont le parent a été remplacé est rattachée (lien facultatif) ou mise de côté
 * (`missing-parent`, lien obligatoire) ; une ligne reportée n'est retirée de `epoch-carry` qu'appliquée, mise de côté, ou écartée par une
 * règle journalisée (trace plus récente, `parent-purged`) ; plus aucun chemin « ni appliquée, ni gardée, ni journalisée ».
 */
async function reapply(deps: SyncDeps, epoch: EpochId, mode: EpochCarryMode, report: ReportSlot): Promise<Map<string, Set<string>>> {
  const touched = new Map<string, Set<string>>();
  const reattachedAll: EpochCarryNoticeItem[] = [];
  const heldAll: EpochCarryNoticeItem[] = [];
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
      const reattached: EpochCarryNoticeItem[] = [];
      const held: EpochCarryNoticeItem[] = [];
      const found: PageReport = { counts: [], restored: [], recreated: [], dropped: [] };
      for (const parked of page) {
        const op = JSON.parse(parked.op) as CarriedOp;
        const t = syncTable(op.t);
        if (!t) continue;
        if (op.tomb !== undefined) {
          found.counts.push({ fields: [], tomb: op.tomb });
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
        found.counts.push({ fields: op.own.map((name) => (op.f[name] as SyncField)[1]), ...(op.late === 1 ? { late: true } : {}) });
        // Y-TECH-05 : état de la ligne juste après (b) (remplacement seulement : en fusion rien n'est remplacé, rien n'est « rétabli »).
        const before = mode === 'replace' ? await carryRowState(repos, t, op.id) : null;
        // Ligne présente : seuls ses propres champs ; ligne absente : la ligne entière, pour pouvoir la recréer.
        const fields = Object.entries(op.f).filter(([name]) => !existed || op.own.includes(name));
        const syncOp: SyncOp = { t: op.t, id: op.id, at: op.at, f: new Map(fields) };
        await applyOps(repos, [syncOp], { localSv: deps.sv, remoteSv: deps.sv, now, knows: () => true, logger: deps.logger, carry: carryPolicy(op, reattached, held) });
        if (before) await classifyRow(repos, t, op.id, before.state, found);
        // Ligne absente après l'application : mise de côté par `applyOps` (`missing-parent` ou `missing-row`, marquée), ou écartée par une
        // règle documentée et journalisée (trace plus récente, `parent-purged` d'un lien obligatoire) ; jamais perdue en silence.
        if (!(await repos.sync.existingIds(t, [op.id])).has(op.id)) continue;
        if (!existed) {
          // Ligne recréée : la nouvelle époque ne la connaît pas ; elle est republiée **entière** (champs des autres appareils compris,
          // avec leurs horloges), sinon les autres appareils ne recevraient que ses champs propres et la mettraient de côté pour toujours.
          await repos.sync.addOutbox([{ table: t.name, rowId: op.id, field: ROW_REPUBLISH_FIELD }]);
        } else {
          const clocks = (await repos.sync.readClocks(t, [op.id])).get(op.id) ?? new Map();
          const row = (await repos.sync.readRows(t, [op.id])).get(op.id);
          // Champ d'un autre auteur reporté et gagnant sur la ligne présente : le publieur ne republie champ par champ que les horloges de cet
          // appareil (ordre des hlc du journal) ; la ligne part donc **entière**, avec les horloges d'origine de chacun de ses champs.
          const foreignWon = op.own.some((name) => {
            const hlc = (op.f[name] as SyncField)[1];
            return hlcDevice(hlc) !== deps.deviceId && (clocks.get(name) ?? clocks.get('*') ?? { hlc: row?.hlc }).hlc === hlc;
          });
          if (foreignWon) {
            await repos.sync.addOutbox([{ table: t.name, rowId: op.id, field: ROW_REPUBLISH_FIELD }]);
            addTouched(touched, t.name, op.id);
            continue;
          }
          const keep = op.own.filter((name) => (clocks.get(name) ?? clocks.get('*') ?? { hlc: row?.hlc }).hlc === (op.f[name] as SyncField)[1]);
          await repos.sync.addOutbox(keep.map((field) => ({ table: t.name, rowId: op.id, field })));
        }
        addTouched(touched, t.name, op.id);
      }
      // Notice et retrait des reports de la page dans la même transaction (reprise après arrêt : ni perte ni doublon).
      if (reattached.length > 0 || held.length > 0) await recordCarryNotice(deps, repos, epoch, now, reattached, held);
      // Y-TECH-05 : compte rendu complété dans la même transaction (reprise après arrêt : aucune ligne comptée deux fois ni oubliée).
      if (report.id === undefined) report.id = await createCarryReport(deps, repos, report, now);
      if (report.id !== null) report.id = await recordCarryReport(deps, repos, epoch, now, report.id, found, parentItemsOf(reattached, held));
      await repos.sync.removeParked(page.map((p) => p.id));
      reattachedAll.push(...reattached);
      heldAll.push(...held);
    });
  }
  // Une ligne par lien et par passe : table, colonne, nombre ; aucun titre, aucun identifiant (critère 11).
  for (const entry of countByLink(reattachedAll)) deps.logger.log(EPOCH_CARRY_REATTACHED_EVENT, entry);
  for (const entry of countByLink(heldAll)) deps.logger.log(EPOCH_CARRY_HELD_EVENT, entry);
  return touched;
}

/** Y-TECH-05 : relevé d'une page de `reapply` pour le compte rendu. */
interface PageReport {
  readonly counts: CarriedOpCount[];
  readonly restored: EpochCarryNamedItem[];
  readonly recreated: EpochCarryNamedItem[];
  readonly dropped: { readonly table: string; readonly rowId: string }[];
}

/** État d'une ligne : vivante, supprimée (`deleted_at`, horloge du champ), purgée (trace) ou absente ; valeurs pour le libellé local. */
async function carryRowState(repos: Repositories, t: SyncTable, id: string): Promise<{ readonly state: CarryRowState; readonly values: ReadonlyMap<string, unknown> | null }> {
  const row = (await repos.sync.readRowsWithClocks(t, [id])).get(id);
  if (row) {
    const hlc = (row.clocks.get('deleted_at') ?? row.clocks.get('*'))?.hlc ?? row.hlc;
    const deleted = t.columns.some((c) => c.name === 'deleted_at') && (row.values.get('deleted_at') ?? null) !== null;
    return { state: { kind: deleted ? 'deleted' : 'alive', hlc }, values: row.values };
  }
  const tomb = (await repos.sync.tombstones(t.name, [id])).get(id);
  return { state: tomb === undefined ? { kind: 'absent' } : { kind: 'purged', hlc: tomb }, values: null };
}

/** Classement d'une ligne après l'application de son report (`src/domain`) ; une ligne de nouveau supprimée sort des listes. */
async function classifyRow(repos: Repositories, t: SyncTable, id: string, before: CarryRowState, page: PageReport): Promise<void> {
  const after = await carryRowState(repos, t, id);
  const verdict = (testHooks.classify ?? classifyCarriedRow)(t.name, id, after.values ? carryReportLabel(t.name, after.values) : null, before, after.state);
  if (verdict) page[verdict.list].push(verdict.item);
  else if (after.state.kind !== 'alive') page.dropped.push({ table: t.name, rowId: id });
}

/**
 * Compte rendu du report en cours : `id` lu dans `sync_meta.epochSwitch` (reprise après arrêt : le même compte rendu est complété),
 * `undefined` tant qu'il n'est pas créé, null si sa création a échoué (journalisé et visible). En-tête établi avant toute écriture.
 */
interface ReportSlot {
  id: number | null | undefined;
  readonly head: EpochCarryReportHead;
  readonly progress: SwitchProgress;
}

async function reportSlot(deps: SyncDeps, progress: SwitchProgress, target: EpochId, options: SwitchOptions): Promise<ReportSlot> {
  // Époque quittée : `sync_meta.epoch` n'est remplacée qu'à l'étape (d), dans sa transaction.
  const from = await readJson<EpochId>(deps.data.repos, META.epoch);
  const parsed = parseEpochId(target);
  const head: EpochCarryReportHead = {
    epoch: target,
    cause: carryCause({ mode: options.mode, reset: options.reset === true, fromN: (from === null ? null : parseEpochId(from)?.n) ?? null, targetN: parsed?.n ?? 0 }),
    reporter: deps.deviceId,
    opener: parsed?.opener ?? progress.from.deviceId,
    mode: options.mode,
    createdAt: new Date(deps.clock.nowMs()).toISOString() as IsoDateTime,
  };
  return { id: progress.report, head, progress };
}

/**
 * Création du compte rendu dans la transaction de la **première page** de (c), ou dans celle de l'étape (d) si rien n'est à reporter :
 * jamais une transaction de plus. Son numéro est mémorisé dans `sync_meta.epochSwitch` dans la même transaction. Y sont copiés les items
 * d'une notice de Y-FIX-04 qu'aucun compte rendu ne nomme encore ; les plus anciens acquittés au-delà de 20 sont supprimés. Disque plein
 * ou erreur d'entrée-sortie : relancé (la transaction est annulée, reprise au cycle suivant) ; autre échec : le report se fait quand même,
 * l'échec est journalisé et visible (`reportFailed`).
 */
async function createCarryReport(deps: SyncDeps, repos: Repositories, slot: ReportSlot, now: IsoDateTime): Promise<number | null> {
  try {
    const reports = await repos.carryReports();
    const id = await reports.create({ ...slot.head, createdAt: now });
    const earlier = noticeItemsNotReported(parseEpochCarryNotice(await repos.sync.getMeta(EPOCH_CARRY_NOTICE_META)), await reports.list(1_000));
    if (earlier.length > 0) await reports.save(id, addNamed(EMPTY_CARRY_REPORT_BODY, { parentReplaced: earlier }), false);
    await reports.prune(EPOCH_CARRY_REPORT_KEEP);
    await writeJson(repos, META.epochSwitch, { ...slot.progress, step: 'c', report: id } satisfies SwitchProgress);
    return id;
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    await reportFailed(deps, repos, slot.head.epoch as EpochId, now, error);
    await writeJson(repos, META.epochSwitch, { ...slot.progress, step: 'c', report: null } satisfies SwitchProgress).catch(() => undefined);
    return null;
  }
}

/** Compteurs et listes de la page ajoutés au compte rendu (même transaction que le retrait des reports) ; null s'il n'a pas pu être écrit. */
async function recordCarryReport(deps: SyncDeps, repos: Repositories, epoch: EpochId, now: IsoDateTime, id: number, page: PageReport, parentReplaced: readonly EpochCarryParentItem[]): Promise<number | null> {
  try {
    const reports = await repos.carryReports();
    const current = await reports.get(id);
    if (!current) throw Object.assign(new Error('compte rendu absent'), { name: 'ReportMissing' });
    let authors = current.authors;
    for (const count of page.counts) authors = addCarriedCount(authors, count);
    const body: EpochCarryReportBody = addNamed({ ...current, authors }, { restored: page.restored, recreated: page.recreated, parentReplaced, dropped: page.dropped });
    await reports.save(id, body, carryReportBanner(current.mode, body));
    return id;
  } catch (error) {
    if (isStorageFailure(error)) throw error;
    await reportFailed(deps, repos, epoch, now, error);
    return null;
  }
}

/**
 * Compte rendu impossible à écrire (autre cause que le stockage) : les données passent avant leur compte rendu. Jamais muet : événement
 * (code seulement, aucun libellé), marque persistante `sync_meta.epochCarryReportFailed` (avertissement de la phase 2) et, dès maintenant,
 * l'indicateur de Y-FIX-04 (`carryNoticeState.ts`) qui lève `carry-report`.
 */
async function reportFailed(deps: SyncDeps, repos: Repositories, epoch: EpochId, at: IsoDateTime, error: unknown): Promise<void> {
  const raw = (error as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' ? raw : error instanceof Error ? error.name : 'unknown';
  deps.logger.log(EPOCH_CARRY_REPORT_FAILED_EVENT, { code });
  markEpochCarryNoticeFailure();
  try {
    await repos.sync.setMeta(EPOCH_CARRY_REPORT_FAILED_META, JSON.stringify({ epoch, at, code }));
  } catch {
    // Journal et indicateur ci-dessus : l'échec reste visible.
  }
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
  /** Y-TECH-05 : changement d'époque d'une réinitialisation (Y-11), même par remplacement : cause « reset » du compte rendu. */
  readonly reset?: boolean;
  readonly knows?: ApplyContext['knows'];
  /** Appareils oubliés (ordre total) : leurs écritures au-delà de la coupure ne sont jamais reportées par la garde générale. */
  readonly forgotten?: ReadonlySet<DeviceId>;
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
    const carried = await materialize(deps, loaded.end.covers, progress.maxSeq, progress.from.deviceId, options.forgotten ?? new Set());
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
  const report = await reportSlot(deps, progress, target, options);
  if (progress.step === 'c') {
    const touched = await reapply(deps, target, options.mode, report);
    if (report.id !== undefined) progress = { ...progress, report: report.id };
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
    // Y-TECH-05 : report sans aucune page (rien à reporter) : compte rendu à zéro, créé ici, dans la transaction qui termine le changement.
    if (report.id === undefined) report.id = await createCarryReport(deps, tx, report, new Date(deps.clock.nowMs()).toISOString() as IsoDateTime);
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

/**
 * Lignes reportées mises de côté (lien obligatoire) que `retryParked` n'a plus gardées : présentes, elles sont republiées **entières**
 * (`'+'`, la nouvelle époque ne les connaît pas) ; elles sortent de `sync_parked` et de la liste `held` de la notice, dans une seule
 * transaction. Chargé à la demande avec ce module (chemin rare). `retryParked` les laisse en place jusque-là : un arrêt entre les deux
 * rejoue l'opération (inchangée) puis revient ici.
 */
export async function releaseCarried(deps: SyncDeps, released: readonly { readonly id: number; readonly table: string; readonly rowId: string }[]): Promise<void> {
  await guarded(deps.data, async (repos) => {
    for (const item of released) {
      const t = syncTable(item.table);
      if (t && (await repos.sync.existingIds(t, [item.rowId])).has(item.rowId)) await repos.sync.addOutbox([{ table: t.name, rowId: item.rowId, field: ROW_REPUBLISH_FIELD }]);
    }
    await repos.sync.removeParked(released.map((r) => r.id));
    const notice = parseEpochCarryNotice(await repos.sync.getMeta(EPOCH_CARRY_NOTICE_META));
    if (!notice) return;
    const gone = new Set(released.map((r) => `${r.table}\u0000${r.rowId}`));
    const held = notice.held.filter((item) => !gone.has(`${item.table}\u0000${item.rowId}`));
    if (held.length === notice.held.length) return;
    const empty = held.length === 0 && notice.reattached.length === 0 && notice.overflow === 0;
    try {
      await repos.sync.setMeta(EPOCH_CARRY_NOTICE_META, empty ? null : JSON.stringify({ ...notice, held }));
    } catch (error) {
      // La donnée passe avant son compte rendu : journalisé, jamais un échec de la reprise des opérations mises de côté.
      deps.logger.log('epoch-carry-notice-failed', { code: error instanceof Error ? error.name : 'unknown' });
    }
  });
}
