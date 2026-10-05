import { isStrictHlc, type SyncField, type SyncValue } from '../../../domain/sync/format';
import { mergeField, type FieldConflict, type LocalField } from '../../../domain/sync/merge';
import { hlcDevice, hlcIso } from '../../../domain/sync/parse';
import { TECHNICAL_COLUMNS, isValidRowId, isValidValue, settingKeyScope, syncColumn, syncTable, type SyncColumn, type SyncTable } from '../../../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../../../domain/types';
import type { SqlExecutor, SqlValue } from '../../driver';
import type { ReintegrateUnknownFields, UnknownCatalogue } from '../syncUnknownRepository';

/**
 * Réintégration des champs de `sync_unknown` devenus connus (Y-07 critères 6 et 7 ; ADR 0011 §3.2, §7.2 ; décision D3). Voir
 * `syncUnknownRepository.ts` pour le contrat.
 *
 * Par ligne (table, identifiant) gardée :
 * - table, colonne et clé de réglage cherchées dans le catalogue (comparaison exacte) ; seuls ses noms entrent dans le SQL ; colonnes
 *   techniques, locales et de clé jamais réintégrées ; valeur contrôlée par le type du catalogue : un champ encore inconnu ou invalide
 *   reste ;
 * - ligne présente : fusion par champ (`mergeField`, règle de hlc ordinaire) ; la valeur reçue plus récente est écrite avec son horloge,
 *   la valeur locale plus récente est gardée ; dans les deux cas le champ quitte `sync_unknown` ; conflit inscrit comme à l'application ;
 *   un hlc égal au repli « * » de la ligne, sans horloge propre du champ, est la **même écriture** reçue quand la colonne n'existait pas
 *   ici : la valeur la complète ; un champ de clé étrangère dont le parent manque reste (comme une opération mise de côté) ;
 * - ligne absente : insérée seulement si tous les champs de la table sont là et ses parents présents (table devenue connue, réglage
 *   devenu partagé) ; sinon le champ reste jusqu'au démarrage suivant ; une trace de purge plus récente retire les champs plus anciens.
 * Une transaction gardée par page de lignes : la garde est posée en tête et retirée avant le COMMIT ; un échec annule la page, garde
 * comprise. Rejouable : un second appel ne trouve plus rien à faire.
 */

const DEFAULT_CATALOGUE: UnknownCatalogue = { table: syncTable, column: syncColumn, settingScope: settingKeyScope };

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

interface Known {
  readonly stored: string;
  readonly col: SyncColumn;
  readonly field: SyncField;
}

interface RowOutcome {
  readonly reintegrated: number;
  readonly superseded: number;
}

const NOTHING: RowOutcome = { reintegrated: 0, superseded: 0 };

/** Valeur gardée (JSON écrit par `putUnknown`) ; undefined si illisible. */
function storedValue(text: SqlValue): SyncValue | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
  } catch {
    return undefined;
  }
}

const maxHlc = (hlcs: readonly Hlc[]): Hlc => hlcs.reduce((a, b) => (b > a ? b : a));

async function upsertClocks(tx: SqlExecutor, t: SyncTable, id: string, clocks: readonly { readonly field: string; readonly hlc: Hlc; readonly base: Hlc | null }[]): Promise<void> {
  for (const clock of clocks) {
    await tx.execute(
      `INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc`,
      [t.name, id, clock.field, clock.hlc, clock.base],
    );
  }
}

async function removeStored(tx: SqlExecutor, table: string, rowId: string, fields: readonly string[]): Promise<void> {
  for (const field of fields) await tx.execute('DELETE FROM sync_unknown WHERE table_name = ? AND row_id = ? AND field = ?', [table, rowId, field]);
}

async function insertConflicts(tx: SqlExecutor, t: SyncTable, rowId: string, conflicts: readonly { readonly field: string; readonly conflict: FieldConflict }[], now: IsoDateTime): Promise<void> {
  for (const { field, conflict: c } of conflicts) {
    await tx.execute(
      `INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc, detected_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM conflict_log WHERE table_name = ? AND row_id = ? AND field = ? AND kept_hlc = ? AND discarded_hlc = ?)`,
      [t.name, rowId, field, JSON.stringify(c.kept.value), JSON.stringify(c.discarded.value), c.kept.device, c.discarded.device, c.kept.hlc, c.discarded.hlc, now, t.name, rowId, field, c.kept.hlc, c.discarded.hlc],
    );
  }
}

/** Réintègre les champs gardés d'une ligne ; `tableName` et `rowId` sont des valeurs reçues, jamais des identifiants SQL. */
async function reintegrateRow(tx: SqlExecutor, catalogue: UnknownCatalogue, tableName: string, rowId: string, now: IsoDateTime): Promise<RowOutcome> {
  const t = catalogue.table(tableName);
  if (!t || !isValidRowId(t, rowId)) return NOTHING;
  if (t.idKind === 'setting' && catalogue.settingScope(rowId) !== 'shared') return NOTHING;

  const stored = await tx.select<{ field: string; value: string | null; hlc: string; base_hlc: string | null }>(
    'SELECT field, value, hlc, base_hlc FROM sync_unknown WHERE table_name = ? AND row_id = ? ORDER BY field',
    [tableName, rowId],
  );
  const known: Known[] = [];
  for (const s of stored) {
    const col = catalogue.column(t.name, s.field);
    if (!col || col.name === t.key || col.name === 'id' || (TECHNICAL_COLUMNS as readonly string[]).includes(col.name) || t.local.includes(col.name)) continue;
    const value = storedValue(s.value);
    if (value === undefined || !isValidValue(col, value) || !isStrictHlc(s.hlc) || !(s.base_hlc === null || isStrictHlc(s.base_hlc))) continue;
    known.push({ stored: s.field, col, field: [value, s.hlc, s.base_hlc as Hlc | null] });
  }
  if (known.length === 0) return NOTHING;

  const rows = await tx.select(`SELECT hlc, ${known.map((k) => k.col.name).join(', ')} FROM ${t.name} WHERE ${t.key} = ?`, [rowId]);
  const row = rows[0];

  if (!row) {
    const tomb = (await tx.select<{ deleted_hlc: string }>('SELECT deleted_hlc FROM sync_tombstone WHERE table_name = ? AND row_id = ?', [t.name, rowId]))[0]?.deleted_hlc;
    if (tomb !== undefined) {
      // Ligne purgée ici : une valeur plus ancienne que la purge ne ressuscite rien (section 5.4) ; une plus récente attend (reste).
      const old = known.filter((k) => k.field[1] <= tomb);
      await removeStored(tx, tableName, rowId, old.map((k) => k.stored));
      return { reintegrated: 0, superseded: old.length };
    }
    const byName = new Map(known.map((k) => [k.col.name, k]));
    if (!t.columns.every((col) => byName.has(col.name))) return NOTHING;
    for (const k of known) if (!(await parentPresent(tx, catalogue, t, k))) return NOTHING;
    const rowHlc = maxHlc(known.map((k) => k.field[1]));
    const cols = t.columns.map((col) => col.name);
    const params: SqlValue[] = [rowId, ...cols.map((name) => (byName.get(name) as Known).field[0]), hlcIso(rowHlc), hlcDevice(rowHlc), rowHlc];
    await tx.execute(`INSERT INTO ${t.name} (${[t.key, ...cols, 'updated_at', 'device_id', 'hlc'].join(', ')}) VALUES (${marks(params.length)})`, params);
    await upsertClocks(tx, t, rowId, [
      { field: '*', hlc: rowHlc, base: null },
      ...known.filter((k) => k.field[1] !== rowHlc || k.field[2] !== null).map((k) => ({ field: k.col.name, hlc: k.field[1], base: k.field[2] })),
    ]);
    await removeStored(tx, tableName, rowId, known.map((k) => k.stored));
    return { reintegrated: known.length, superseded: 0 };
  }

  // Ligne présente : fusion par champ, comme `apply.ts` (horloge du champ, sinon repli « * », sinon hlc de la ligne).
  const rowHlc = row['hlc'] as Hlc;
  const clocks = new Map(
    (await tx.select<{ field: string; hlc: string; base_hlc: string | null }>('SELECT field, hlc, base_hlc FROM sync_field_clock WHERE table_name = ? AND row_id = ?', [t.name, rowId])).map((c) => [
      c.field,
      { hlc: c.hlc as Hlc, base: c.base_hlc as Hlc | null },
    ]),
  );
  const pending = new Set((await tx.select<{ field: string }>('SELECT field FROM sync_outbox WHERE table_name = ? AND row_id = ?', [t.name, rowId])).map((p) => p.field));
  const applied: Known[] = [];
  /** Champs gagnants dont le parent n'est pas (encore) ici : ils restent, comme une opération mise de côté par `apply.ts`. */
  const waiting = new Set<Known>();
  const conflicts: { field: string; conflict: FieldConflict }[] = [];
  for (const k of known) {
    const own = clocks.get(k.col.name);
    const clock = own ?? clocks.get('*') ?? { hlc: rowHlc, base: null };
    const local: LocalField = { value: (row[k.col.name] ?? null) as SyncValue, hlc: clock.hlc, base: clock.base, pending: pending.has(k.col.name) || pending.has('*') };
    // Même hlc que le repli de la ligne, sans horloge propre : c'est la même écriture, reçue ici quand la colonne n'existait pas ; la
    // valeur locale n'est que la valeur par défaut de la migration. La valeur gardée complète cette écriture (sinon elle serait perdue).
    const sameWrite = own === undefined && k.field[1] === clock.hlc;
    const decision = sameWrite ? { apply: true, conflict: null } : mergeField(local, k.field);
    if (decision.apply && !(await parentPresent(tx, catalogue, t, k))) {
      waiting.add(k);
      continue;
    }
    if (decision.apply) applied.push(k);
    if (decision.conflict && k.col.conflictVisible) conflicts.push({ field: k.col.name, conflict: decision.conflict });
  }
  if (applied.length > 0) {
    // Repli « * » figé avant que le hlc de la ligne ne bouge (les champs sans horloge propre gardent l'ancien hlc).
    if (!clocks.has('*')) await upsertClocks(tx, t, rowId, [{ field: '*', hlc: rowHlc, base: null }]);
    const appliedMax = maxHlc(applied.map((k) => k.field[1]));
    const meta = appliedMax > rowHlc ? [hlcIso(appliedMax), hlcDevice(appliedMax), appliedMax] : [];
    const sets = [...applied.map((k) => `${k.col.name} = ?`), ...(meta.length > 0 ? ['updated_at = ?', 'device_id = ?', 'hlc = ?'] : [])];
    await tx.execute(`UPDATE ${t.name} SET ${sets.join(', ')} WHERE ${t.key} = ?`, [...applied.map((k) => k.field[0]), ...meta, rowId]);
    await upsertClocks(tx, t, rowId, applied.map((k) => ({ field: k.col.name, hlc: k.field[1], base: k.field[2] })));
    // Une écriture locale en attente écrasée par une valeur plus récente ne sera pas publiée.
    for (const k of applied) if (pending.has(k.col.name)) await tx.execute('DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ? AND field = ?', [t.name, rowId, k.col.name]);
  }
  await insertConflicts(tx, t, rowId, conflicts, now);
  await removeStored(tx, tableName, rowId, known.filter((k) => !waiting.has(k)).map((k) => k.stored));
  return { reintegrated: applied.length, superseded: known.length - applied.length - waiting.size };
}

/** Parent visé par un champ de clé étrangère (catalogue) présent ici ; vrai pour un champ qui n'en vise pas, ou une valeur nulle. */
async function parentPresent(tx: SqlExecutor, catalogue: UnknownCatalogue, t: SyncTable, k: Known): Promise<boolean> {
  const parent = t.parents.find((p) => p.column === k.col.name);
  const value = k.field[0];
  if (!parent || typeof value !== 'string') return true;
  const pt = catalogue.table(parent.table);
  return pt !== undefined && (await tx.select(`SELECT 1 AS present FROM ${pt.name} WHERE ${pt.key} = ?`, [value])).length > 0;
}

export const reintegrateUnknownFields: ReintegrateUnknownFields = async (db, options) => {
  const catalogue = options.catalogue ?? DEFAULT_CATALOGUE;
  const pageSize = Math.max(1, options.pageSize ?? 200);
  let reintegrated = 0;
  let superseded = 0;
  let after: { table: string; rowId: string } | null = null;
  for (;;) {
    const pairs: { table_name: string; row_id: string }[] = await db.select<{ table_name: string; row_id: string }>(
      after === null
        ? 'SELECT DISTINCT table_name, row_id FROM sync_unknown ORDER BY table_name, row_id LIMIT ?'
        : 'SELECT DISTINCT table_name, row_id FROM sync_unknown WHERE (table_name, row_id) > (?, ?) ORDER BY table_name, row_id LIMIT ?',
      after === null ? [pageSize] : [after.table, after.rowId, pageSize],
    );
    const last = pairs.at(-1);
    if (!last) break;
    after = { table: last.table_name, rowId: last.row_id };
    const page = await db.transaction(async (tx) => {
      await tx.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
      let r = 0;
      let s = 0;
      for (const pair of pairs) {
        const outcome = await reintegrateRow(tx, catalogue, pair.table_name, pair.row_id, options.now);
        r += outcome.reintegrated;
        s += outcome.superseded;
      }
      await tx.execute('DELETE FROM sync_guard');
      return { r, s };
    });
    reintegrated += page.r;
    superseded += page.s;
    if (pairs.length < pageSize) break;
  }
  const remaining = Number((await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_unknown'))[0]?.n ?? 0);
  return { reintegrated, superseded, remaining };
};
