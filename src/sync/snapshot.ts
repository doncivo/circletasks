import type { ExportedRow, FieldClock, Repositories, Tombstone } from '../db/repositories';
import { APPLY_BATCH_OPS, MAX_RECORD_PLAINTEXT_BYTES, PAGE_ROWS, SNAPSHOT_CHUNK_PLAINTEXT_BYTES, utf8Bytes, type DeviceAck, type EpochId, type SnapshotClocks, type SnapshotRecord, type SnapshotRow, type SyncField, type SyncOp, type SyncValue } from '../domain/sync/format';
import { isNaturalId, type NaturalIdTable } from '../domain/sync/naturalIds';
import { hlcIso, parseSnapshotRecord, snapshotRecordToText, snapshotRowToJson } from '../domain/sync/parse';
import { isTooFarAhead } from '../domain/sync/drift';
import { FIXED_SPACE_IDS, SYNC_TABLES, settingKeyScope, syncTable, type SyncTable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc } from '../domain/types';
import { applyOps, mergeTouched, type ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';
import { purgeRows, type PurgeItem } from './purge';

/**
 * Instantanés (ADR 0011, sections 5.1, 5.2, 5.5 et 9.1 (b) ; Y-02 critères 11 et 12, Y-09 critères 7 et 11).
 *
 * Écriture : lignes de toutes les tables publiées (supprimées comprises) avec leurs horloges, découpées par taille (64 Kio), une
 * ligne de plus de 64 Kio dans un enregistrement dédié, puis traces, champs inconnus et `snap-end` (avec `covers`) en dernier.
 * Lecture : un instantané sans `snap-end` valide est incomplet et ignoré. Application en **fusion** (reprise, nouvel appareil) ou en
 * **remplacement** (« Appliquer partout », époques concurrentes).
 */

const rowJsonBytes = (row: SnapshotRow): number => utf8Bytes(JSON.stringify(snapshotRowToJson(row))) + 1;

function toSnapshotRow(t: SyncTable, row: ExportedRow): SnapshotRow {
  const values = new Map<string, SyncValue>([[t.key, row.id], ...row.values]);
  const star = row.clocks.get('*')?.hlc ?? row.hlc;
  const clocks = new Map<string, Hlc>([['*', star]]);
  for (const [field, clock] of row.clocks) if (field !== '*' && clock.hlc !== star) clocks.set(field, clock.hlc);
  return [t.name, values, clocks];
}

/** Pages d'enregistrements (texte clair) d'un instantané de la base locale. */
export async function* snapshotPages(repos: Repositories, epoch: EpochId, covers: ReadonlyMap<DeviceId, DeviceAck>, sv: number): AsyncGenerator<readonly string[]> {
  let count = 0;
  let rows: SnapshotRow[] = [];
  let bytes = 0;
  const page: string[] = [];
  const push = (record: SnapshotRecord): void => {
    page.push(snapshotRecordToText(record));
    count += 1;
  };
  const flushRows = (): void => {
    if (rows.length > 0) push({ k: 'snap-rows', rows });
    rows = [];
    bytes = 0;
  };
  for (const t of SYNC_TABLES) {
    let after: string | null = null;
    for (;;) {
      const exported = await repos.sync.exportRows(t, after, PAGE_ROWS);
      if (exported.length === 0) break;
      after = (exported.at(-1) as ExportedRow).id;
      for (const row of exported) {
        if (t.name === 'settings' && settingKeyScope(row.id) !== 'shared') continue;
        const snap = toSnapshotRow(t, row);
        const size = rowJsonBytes(snap);
        if (size > SNAPSHOT_CHUNK_PLAINTEXT_BYTES) {
          if (size <= MAX_RECORD_PLAINTEXT_BYTES) push({ k: 'snap-row', t: snap[0], row: snap[1], clocks: snap[2] });
          continue;
        }
        if (bytes + size > SNAPSHOT_CHUNK_PLAINTEXT_BYTES) flushRows();
        rows.push(snap);
        bytes += size;
      }
      if (page.length > 0) yield page.splice(0);
    }
  }
  flushRows();
  let afterTomb: { table: string; rowId: string } | null = null;
  for (;;) {
    const tombs = await repos.sync.exportTombstones(afterTomb, 1_000);
    if (tombs.length === 0) break;
    const last = tombs.at(-1) as { table: string; rowId: string };
    afterTomb = { table: last.table, rowId: last.rowId };
    push({ k: 'snap-tombstones', ids: tombs.map((tomb) => [tomb.table, tomb.rowId, tomb.deletedHlc] as const) });
  }
  let afterRowid = 0;
  for (;;) {
    const unknown = await repos.sync.exportUnknown(afterRowid, 500);
    if (unknown.length === 0) break;
    afterRowid = (unknown.at(-1) as { rowid: number }).rowid;
    push({ k: 'snap-unknown', fields: unknown.map((u) => ({ t: u.table, id: u.rowId, field: u.field, value: u.value, hlc: u.hlc, base: u.base, sv: u.sv })) });
  }
  push({ k: 'snap-end', count, covers, epoch, sv });
  yield page.splice(0);
}


/** Instantané lu et vérifié (dernier enregistrement `snap-end`, nombre conforme). */
export interface LoadedSnapshot {
  readonly records: readonly SnapshotRecord[];
  readonly end: Extract<SnapshotRecord, { k: 'snap-end' }>;
}

/** Lecture complète d'un instantané ; null s'il est incomplet, en attente d'iCloud ou invalide. */
export async function loadSnapshot(deps: SyncDeps, deviceId: DeviceId, epoch: EpochId, seq: number): Promise<LoadedSnapshot | null | 'cloud-pending'> {
  const texts: string[] = [];
  let from = 0;
  for (;;) {
    const page = await deps.platform.readSnapshot({ deviceId, epoch, seq, fromRecord: from });
    texts.push(...page.records);
    from = page.next.record;
    if (page.status === 'cloud-pending') return 'cloud-pending';
    if (page.status === 'truncated') return null;
    if (page.status === 'complete') break;
    if (page.records.length === 0) return null;
  }
  const records: SnapshotRecord[] = [];
  for (const text of texts) {
    const record = parseSnapshotRecord(text);
    if (!record) return null;
    records.push(record);
  }
  const end = records.at(-1);
  if (!end || end.k !== 'snap-end' || end.count !== records.length - 1 || end.epoch !== epoch) return null;
  return { records: records.slice(0, -1), end };
}

function rowsOf(records: readonly SnapshotRecord[]): SnapshotRow[] {
  return records.flatMap((r): SnapshotRow[] => (r.k === 'snap-rows' ? [...r.rows] : r.k === 'snap-row' ? [[r.t, r.row, r.clocks]] : []));
}

/** Plus grand hlc d'un instantané : horloges des lignes, traces, champs inconnus (bases comprises). */
export function snapshotMaxHlc(snapshot: LoadedSnapshot): Hlc | null {
  let max: Hlc | null = null;
  const see = (hlc: Hlc | null): void => {
    if (hlc !== null && (max === null || hlc > max)) max = hlc;
  };
  for (const record of snapshot.records) {
    if (record.k === 'snap-rows') for (const [, , clocks] of record.rows) for (const hlc of clocks.values()) see(hlc);
    else if (record.k === 'snap-row') for (const hlc of record.clocks.values()) see(hlc);
    else if (record.k === 'snap-tombstones') for (const [, , hlc] of record.ids) see(hlc);
    else if (record.k === 'snap-unknown')
      for (const f of record.fields) {
        see(f.hlc);
        see(f.base);
      }
  }
  return max;
}

/**
 * Contrôle de dérive d'un instantané (section 4.4, comme pour un enregistrement de journal) puis `HlcClock.receive()` de son plus grand
 * hlc : les écritures locales qui suivent l'emportent toujours sur ce qu'il contient. Faux (journalisé) si un hlc dépasse l'heure + 1 h :
 * l'instantané n'est pas appliqué.
 */
export function admitSnapshot(deps: SyncDeps, snapshot: LoadedSnapshot): boolean {
  const max = snapshotMaxHlc(snapshot);
  if (max === null) return true;
  if (isTooFarAhead(max, deps.clock.nowMs())) {
    deps.logger.log('snapshot-clock-ahead', { epoch: snapshot.end.epoch });
    return false;
  }
  deps.hlc.receive(max);
  return true;
}

/** Ligne d'instantané → opération complète (un hlc par champ, base inconnue). */
function rowToOp(t: SyncTable, row: ReadonlyMap<string, SyncValue>, clocks: SnapshotClocks): SyncOp | null {
  const id = row.get(t.key);
  const star = clocks.get('*');
  if (typeof id !== 'string' || star === undefined) return null;
  const f = new Map<string, SyncField>();
  let max = star;
  for (const col of t.columns) {
    if (!row.has(col.name)) continue;
    const hlc = clocks.get(col.name) ?? star;
    if (hlc > max) max = hlc;
    f.set(col.name, [row.get(col.name) ?? null, hlc, null]);
  }
  return f.size === 0 ? null : { t: t.name, id, at: hlcIso(max), f };
}

export interface SnapshotApplyResult {
  readonly touched: Map<string, Set<string>>;
  readonly conflicts: number;
}

/** Arrêt simulé pendant l'application d'un instantané (tests de reprise). */
export interface SnapshotTestHooks {
  /** Avant la transaction du lot de lignes `index` (0, 1, …). */
  beforeBatch?: (index: number) => void;
  /** Avant la dernière transaction (traces, champs inconnus, curseurs). */
  beforeFinal?: () => void;
}

let testHooks: SnapshotTestHooks = {};
export function setSnapshotTestHooks(hooks: SnapshotTestHooks): void {
  testHooks = hooks;
}

/** Travail ajouté à une transaction gardée de l'application (curseurs de la reprise, report des écritures d'un changement d'époque). */
export type SnapshotTxHook = (repos: Repositories) => Promise<void>;

/**
 * Reprise en **fusion** (section 5.5) : lignes fusionnées par hlc, identifiants purgés appliqués, champs inconnus gardés. Les lots de
 * lignes se rejouent sans effet (fusion idempotente, conflits non réinscrits) ; `finalize` s'exécute dans la **dernière** transaction,
 * avec les traces et les champs inconnus : c'est là que la reprise pose ses curseurs. `'clock-ahead'` : instantané refusé (dérive).
 */
export async function mergeSnapshot(
  deps: SyncDeps,
  snapshot: LoadedSnapshot,
  ctx: Omit<ApplyContext, 'fromSnapshot'>,
  onProgress?: (done: number, total: number) => void,
  finalize?: SnapshotTxHook,
): Promise<SnapshotApplyResult | 'clock-ahead'> {
  if (!admitSnapshot(deps, snapshot)) return 'clock-ahead';
  const touched = new Map<string, Set<string>>();
  let conflicts = 0;
  const ops: SyncOp[] = [];
  for (const [table, row, clocks] of rowsOf(snapshot.records)) {
    const t = syncTable(table);
    const op = t ? rowToOp(t, row, clocks) : null;
    if (op) ops.push(op);
  }
  for (let i = 0; i < ops.length; i += APPLY_BATCH_OPS) {
    testHooks.beforeBatch?.(i / APPLY_BATCH_OPS);
    const batch = ops.slice(i, i + APPLY_BATCH_OPS);
    const result = await guarded(deps.data, (repos) => applyOps(repos, batch, { ...ctx, fromSnapshot: true }));
    mergeTouched(touched, result.touched);
    conflicts += result.conflicts;
    onProgress?.(Math.min(ops.length, i + APPLY_BATCH_OPS), ops.length);
  }
  testHooks.beforeFinal?.();
  await guarded(deps.data, async (repos) => {
    await applySnapshotTombstones(deps, repos, snapshot, touched, false);
    await keepSnapshotUnknown(repos, snapshot);
    await finalize?.(repos);
  });
  return { touched, conflicts };
}

function addTouched(touched: Map<string, Set<string>>, table: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const set = touched.get(table) ?? new Set<string>();
  for (const id of ids) set.add(id);
  touched.set(table, set);
}

/**
 * Identifiants purgés de l'instantané, enfants d'abord : la ligne locale correspondante disparaît (sauf recréation complète plus récente
 * d'un identifiant naturel) avec ses rappels (`purge.ts`) ; une ligne qui a encore des enfants est écartée et journalisée.
 */
async function applySnapshotTombstones(deps: SyncDeps, repos: Repositories, snapshot: LoadedSnapshot, touched: Map<string, Set<string>>, replace: boolean): Promise<void> {
  const now = hlcIso(deps.hlc.now());
  if (replace) await repos.sync.clearTombstones();
  const byTable = new Map<string, (readonly [string, string, Hlc])[]>();
  for (const record of snapshot.records) {
    if (record.k !== 'snap-tombstones') continue;
    for (const tomb of record.ids) {
      const list = byTable.get(tomb[0]);
      if (list) list.push(tomb);
      else byTable.set(tomb[0], [tomb]);
    }
  }
  for (const t of [...SYNC_TABLES].reverse()) {
    const items = (byTable.get(t.name) ?? []).filter(([, id]) => t.purgeable && !(t.name === 'space' && FIXED_SPACE_IDS.has(id)));
    for (let i = 0; i < items.length; i += PAGE_ROWS) {
      const page = items.slice(i, i + PAGE_ROWS);
      const ids = page.map((item) => item[1]);
      const [rows, clocks] = await Promise.all([repos.sync.readRows(t, ids), repos.sync.readClocks(t, ids)]);
      const absent: Tombstone[] = [];
      const purge: PurgeItem[] = [];
      for (const [, id, deletedHlc] of page) {
        const row = rows.get(id);
        if (!row) {
          absent.push({ table: t.name, rowId: id, deletedHlc });
          continue;
        }
        const rowClocks = clocks.get(id) ?? new Map<string, FieldClock>();
        const fieldHlcs = t.columns.map((c) => (rowClocks.get(c.name) ?? rowClocks.get('*') ?? { hlc: row.hlc }).hlc);
        const recreated = t.idKind === 'natural' && isNaturalId(t.name as NaturalIdTable, id) && fieldHlcs.every((h) => h > deletedHlc);
        if (recreated) continue;
        if (fieldHlcs.some((h) => h > deletedHlc)) deps.logger.log('apply-abandoned', { table: t.name, reason: 'purged' });
        purge.push({ id, deletedHlc });
      }
      await repos.sync.insertTombstones(absent, now);
      const done = await purgeRows(repos, t, purge, now, deps.logger);
      addTouched(
        touched,
        t.name,
        done.purged.map((item) => item.id),
      );
      addTouched(touched, 'reminder', done.reminders);
    }
  }
}

async function keepSnapshotUnknown(repos: Repositories, snapshot: LoadedSnapshot): Promise<void> {
  for (const record of snapshot.records) {
    if (record.k !== 'snap-unknown') continue;
    for (const f of record.fields) await repos.sync.putUnknown({ table: f.t, rowId: f.id, field: f.field, value: f.value, hlc: f.hlc, base: f.base, sv: f.sv });
  }
}

/**
 * **Remplacement** (section 9.1 (b)) : les tables publiées, leurs horloges, les traces et les champs inconnus deviennent ceux de
 * l'instantané. Les colonnes locales (`task.discarded`, `token_ref`…) et les réglages locaux sont gardés ; les espaces fixes ne sont
 * jamais supprimés. Les lignes absentes de l'instantané sont supprimées physiquement (sous garde, enfants d'abord ; une ligne qui a
 * encore des enfants est gardée et journalisée). `beforeTx` s'exécute en tête de **chaque** transaction gardée (report des écritures
 * locales faites pendant le changement d'époque). `'clock-ahead'` : instantané refusé (dérive), rien n'est modifié.
 */
export async function replaceFromSnapshot(deps: SyncDeps, snapshot: LoadedSnapshot, beforeTx?: SnapshotTxHook): Promise<SnapshotApplyResult | 'clock-ahead'> {
  if (!admitSnapshot(deps, snapshot)) return 'clock-ahead';
  const touched = new Map<string, Set<string>>();
  const keep = new Map<string, Set<string>>();
  const rows = rowsOf(snapshot.records);
  for (let i = 0; i < rows.length; i += APPLY_BATCH_OPS) {
    const page = rows.slice(i, i + APPLY_BATCH_OPS);
    await guarded(deps.data, async (repos) => {
      await beforeTx?.(repos);
      for (const [table, row, clocks] of page) {
        const t = syncTable(table);
        const id = row.get(t?.key ?? 'id');
        const star = clocks.get('*');
        if (!t || typeof id !== 'string' || star === undefined) continue;
        if (t.name === 'settings' && settingKeyScope(id) !== 'shared') continue;
        const values = new Map(t.columns.filter((c) => row.has(c.name)).map((c) => [c.name, row.get(c.name) ?? null] as const));
        let max = star;
        for (const hlc of clocks.values()) if (hlc > max) max = hlc;
        const meta = { hlc: max, updatedAt: hlcIso(max), deviceId: max.slice(21) };
        const exists = (await repos.sync.existingIds(t, [id])).has(id);
        if (exists) await repos.sync.updateRow(t, id, values, meta);
        else await repos.sync.insertRow(t, id, values, meta);
        await repos.sync.replaceClocks(
          t,
          id,
          [...clocks].map(([field, hlc]) => ({ field, hlc, base: null })),
        );
        addTouched(keep as Map<string, Set<string>>, t.name, [id]);
        addTouched(touched, t.name, [id]);
      }
    });
  }
  // Lignes absentes de l'instantané : supprimées, enfants d'abord.
  for (const t of [...SYNC_TABLES].reverse()) {
    const kept = keep.get(t.name) ?? new Set<string>();
    const drop: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await deps.data.repos.sync.exportRows(t, after, PAGE_ROWS);
      if (page.length === 0) break;
      after = (page.at(-1) as ExportedRow).id;
      for (const row of page) {
        if (kept.has(row.id)) continue;
        if (t.name === 'settings') continue; // réglage jamais publié ou local : valeur locale gardée (jamais purgé, section 5.4)
        if (t.name === 'space' && FIXED_SPACE_IDS.has(row.id)) continue;
        drop.push(row.id);
      }
    }
    if (drop.length === 0) continue;
    for (let i = 0; i < drop.length; i += PAGE_ROWS) {
      const part = drop.slice(i, i + PAGE_ROWS);
      await guarded(deps.data, async (repos) => {
        await beforeTx?.(repos);
        const blocked = await repos.sync.withChildren(t, part);
        if (blocked.size > 0) deps.logger.log('replace-skipped', { table: t.name, reason: 'live-children', count: blocked.size });
        const gone = part.filter((id) => !blocked.has(id));
        if (t.name === 'calendar_account') await repos.sync.deleteExternalEventsOf(gone);
        await repos.sync.deleteRows(t, gone);
        addTouched(touched, t.name, gone);
      });
    }
  }
  await guarded(deps.data, async (repos) => {
    await beforeTx?.(repos);
    await repos.sync.clearUnknown();
    await applySnapshotTombstones(deps, repos, snapshot, touched, true);
    await keepSnapshotUnknown(repos, snapshot);
  });
  return { touched, conflicts: 0 };
}
