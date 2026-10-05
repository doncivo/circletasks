import type { ExportedRow, Repositories } from '../db/repositories';
import { APPLY_BATCH_OPS, MAX_RECORD_PLAINTEXT_BYTES, PAGE_ROWS, SNAPSHOT_CHUNK_PLAINTEXT_BYTES, utf8Bytes, type DeviceAck, type EpochId, type SnapshotClocks, type SnapshotRecord, type SnapshotRow, type SyncField, type SyncOp, type SyncValue } from '../domain/sync/format';
import { isNaturalId, type NaturalIdTable } from '../domain/sync/naturalIds';
import { hlcIso, parseSnapshotRecord, snapshotRecordToText, snapshotRowToJson } from '../domain/sync/parse';
import { FIXED_SPACE_IDS, SHARED_SETTING_KEYS, SYNC_TABLES, settingKeyScope, syncTable, type SyncTable } from '../domain/sync/syncTables';
import type { DeviceId, Hlc } from '../domain/types';
import { applyOps, mergeTouched, type ApplyContext } from './apply';
import type { SyncDeps } from './deps';
import { guarded } from './guarded';

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
  let offset = 0;
  for (;;) {
    const unknown = await repos.sync.exportUnknown(offset, 500);
    if (unknown.length === 0) break;
    offset += unknown.length;
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

/** Reprise en **fusion** (section 5.5) : lignes fusionnées par hlc, identifiants purgés appliqués, champs inconnus gardés. */
export async function mergeSnapshot(deps: SyncDeps, snapshot: LoadedSnapshot, ctx: Omit<ApplyContext, 'fromSnapshot'>, onProgress?: (done: number, total: number) => void): Promise<SnapshotApplyResult> {
  const touched = new Map<string, Set<string>>();
  let conflicts = 0;
  const ops: SyncOp[] = [];
  for (const [table, row, clocks] of rowsOf(snapshot.records)) {
    const t = syncTable(table);
    const op = t ? rowToOp(t, row, clocks) : null;
    if (op) ops.push(op);
  }
  for (let i = 0; i < ops.length; i += APPLY_BATCH_OPS) {
    const batch = ops.slice(i, i + APPLY_BATCH_OPS);
    const result = await guarded(deps.data, (repos) => applyOps(repos, batch, { ...ctx, fromSnapshot: true }));
    mergeTouched(touched, result.touched);
    conflicts += result.conflicts;
    onProgress?.(Math.min(ops.length, i + APPLY_BATCH_OPS), ops.length);
  }
  await applySnapshotTombstones(deps, snapshot, touched, false);
  await keepSnapshotUnknown(deps, snapshot);
  return { touched, conflicts };
}

/** Identifiants purgés de l'instantané : la ligne locale correspondante disparaît (sauf recréation complète plus récente d'un identifiant naturel). */
async function applySnapshotTombstones(deps: SyncDeps, snapshot: LoadedSnapshot, touched: Map<string, Set<string>>, replace: boolean): Promise<void> {
  const tombs = snapshot.records.flatMap((r) => (r.k === 'snap-tombstones' ? r.ids : []));
  const now = hlcIso(deps.hlc.now());
  await guarded(deps.data, async (repos) => {
    if (replace) await repos.sync.clearTombstones();
    for (let i = 0; i < tombs.length; i += PAGE_ROWS) {
      const page = tombs.slice(i, i + PAGE_ROWS);
      const byTable = new Map<SyncTable, (readonly [string, string, Hlc])[]>();
      for (const tomb of page) {
        const t = syncTable(tomb[0]);
        if (t && t.purgeable && !(t.name === 'space' && FIXED_SPACE_IDS.has(tomb[1]))) byTable.set(t, [...(byTable.get(t) ?? []), tomb]);
      }
      for (const [t, items] of byTable) {
        const ids = items.map((item) => item[1]);
        const [rows, clocks] = await Promise.all([repos.sync.readRows(t, ids), repos.sync.readClocks(t, ids)]);
        const purge: string[] = [];
        for (const [, id, deletedHlc] of items) {
          const row = rows.get(id);
          if (!row) continue;
          const rowClocks = clocks.get(id) ?? new Map();
          const fieldHlcs = t.columns.map((c) => (rowClocks.get(c.name) ?? rowClocks.get('*') ?? { hlc: row.hlc }).hlc);
          const recreated = t.idKind === 'natural' && isNaturalId(t.name as NaturalIdTable, id) && fieldHlcs.every((h) => h > deletedHlc);
          if (recreated) continue;
          if (fieldHlcs.some((h) => h > deletedHlc)) deps.logger.log('apply-abandoned', { table: t.name, reason: 'purged' });
          purge.push(id);
        }
        if (t.name === 'calendar_account') await repos.sync.deleteExternalEventsOf(purge);
        await repos.sync.deleteRows(t, purge);
        for (const id of purge) {
          const set = touched.get(t.name) ?? new Set<string>();
          set.add(id);
          touched.set(t.name, set);
        }
        await repos.sync.insertTombstones(items.filter((item) => !rows.has(item[1]) || purge.includes(item[1])).map(([table, rowId, hlc]) => ({ table, rowId, deletedHlc: hlc })), now);
      }
    }
  });
}

async function keepSnapshotUnknown(deps: SyncDeps, snapshot: LoadedSnapshot): Promise<void> {
  const fields = snapshot.records.flatMap((r) => (r.k === 'snap-unknown' ? r.fields : []));
  if (fields.length === 0) return;
  await guarded(deps.data, async (repos) => {
    for (const f of fields) await repos.sync.putUnknown({ table: f.t, rowId: f.id, field: f.field, value: f.value, hlc: f.hlc, base: f.base, sv: f.sv });
  });
}

/**
 * **Remplacement** (section 9.1 (b)) : les tables publiées, leurs horloges, les traces et les champs inconnus deviennent ceux de
 * l'instantané. Les colonnes locales (`task.discarded`, `token_ref`…) et les réglages locaux sont gardés ; les espaces fixes ne sont
 * jamais supprimés. Les lignes absentes de l'instantané sont supprimées physiquement (sous garde, ordre topologique inverse).
 */
export async function replaceFromSnapshot(deps: SyncDeps, snapshot: LoadedSnapshot): Promise<SnapshotApplyResult> {
  const touched = new Map<string, Set<string>>();
  const keep = new Map<string, Set<string>>();
  const rows = rowsOf(snapshot.records);
  for (let i = 0; i < rows.length; i += APPLY_BATCH_OPS) {
    const page = rows.slice(i, i + APPLY_BATCH_OPS);
    await guarded(deps.data, async (repos) => {
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
        await repos.sync.replaceClocks(t, id, [...clocks].map(([field, hlc]) => ({ field, hlc, base: null })));
        const set = keep.get(t.name) ?? new Set<string>();
        set.add(id);
        keep.set(t.name, set);
        const tset = touched.get(t.name) ?? new Set<string>();
        tset.add(id);
        touched.set(t.name, tset);
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
        if (t.name === 'settings' && !(SHARED_SETTING_KEYS as readonly string[]).includes(row.id)) continue;
        if (t.name === 'space' && FIXED_SPACE_IDS.has(row.id)) continue;
        if (t.name === 'settings') continue; // réglage partagé jamais publié : valeur locale gardée (jamais purgé, section 5.4)
        drop.push(row.id);
      }
    }
    if (drop.length === 0) continue;
    await guarded(deps.data, async (repos) => {
      if (t.name === 'calendar_account') await repos.sync.deleteExternalEventsOf(drop);
      await repos.sync.deleteRows(t, drop);
    });
    const tset = touched.get(t.name) ?? new Set<string>();
    for (const id of drop) tset.add(id);
    touched.set(t.name, tset);
  }
  await guarded(deps.data, (repos) => repos.sync.clearUnknown());
  await applySnapshotTombstones(deps, snapshot, touched, true);
  await keepSnapshotUnknown(deps, snapshot);
  return { touched, conflicts: 0 };
}
