import { decideReintegration, keptFieldsOf, REINTEGRATION_FAILURE_META, type ClockState, type ReintegrationDecision, type ReintegrationFailure, type StoredUnknown } from '../../../domain/sync/compat';
import type { SyncValue } from '../../../domain/sync/format';
import { isValidRowId, settingKeyScope, syncColumn, syncTable, tableRank, type SyncTable } from '../../../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../../../domain/types';
import type { SqlExecutor, SqlValue } from '../../driver';
import type { ReintegrateUnknownFields, UnknownCatalogue } from '../syncUnknownRepository';

/**
 * Réintégration des champs de `sync_unknown` devenus connus (Y-07 critères 6 et 7 ; ADR 0011 §3.2, §7.2 ; décision D3). Voir
 * `syncUnknownRepository.ts` pour le contrat. Ce module **lit et écrit** seulement : les champs réintégrables (`keptFieldsOf`) et la
 * décision par ligne (`decideReintegration` : horloges, « même écriture », métadonnées, trace de purge, attente d'un parent) sont des
 * règles pures de `src/domain/sync/compat.ts`.
 *
 * - Table, colonne et clé de réglage cherchées dans le catalogue (comparaison exacte) ; seuls ses noms entrent dans le SQL ; les noms
 *   gardés ne sont que des paramètres liés.
 * - Tables dans l'ordre parent → enfant du catalogue, puis nouveau passage tant qu'un passage a fait des progrès (parent dans la même
 *   table) : un enfant et son parent tous deux en attente sont réintégrés au même démarrage.
 * - Une transaction gardée par page de lignes, chaque ligne dans un point de sauvegarde : une ligne en échec est annulée seule (ses champs
 *   restent, `onRowError` reçoit le nom de l'erreur) et n'est plus retentée avant le démarrage suivant ; la garde est posée en tête et
 *   retirée avant le COMMIT ; un échec hors d'une ligne annule la page, garde comprise. Rejouable.
 */

const DEFAULT_CATALOGUE: UnknownCatalogue = { table: syncTable, column: syncColumn, settingScope: settingKeyScope };

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

interface RowOutcome {
  readonly reintegrated: number;
  readonly superseded: number;
}

const NOTHING: RowOutcome = { reintegrated: 0, superseded: 0 };

/** Lecture de l'état local d'une ligne (valeurs des colonnes gardées, horloges, file, trace, parents absents). */
async function readRow(tx: SqlExecutor, catalogue: UnknownCatalogue, t: SyncTable, rowId: string, fields: readonly { readonly name: string; readonly value: SyncValue }[]) {
  const row = (await tx.select(`SELECT hlc, ${fields.map((f) => f.name).join(', ')} FROM ${t.name} WHERE ${t.key} = ?`, [rowId]))[0];
  const missingParents = new Set<string>();
  for (const f of fields) {
    const parent = t.parents.find((p) => p.column === f.name);
    if (!parent || typeof f.value !== 'string') continue;
    const pt = catalogue.table(parent.table);
    if (!pt || (await tx.select(`SELECT 1 AS present FROM ${pt.name} WHERE ${pt.key} = ?`, [f.value])).length === 0) missingParents.add(f.name);
  }
  if (!row) {
    const tomb = (await tx.select<{ deleted_hlc: string }>('SELECT deleted_hlc FROM sync_tombstone WHERE table_name = ? AND row_id = ?', [t.name, rowId]))[0]?.deleted_hlc;
    return { row: null, tombstone: (tomb ?? null) as Hlc | null, missingParents };
  }
  const clocks = new Map<string, ClockState>(
    (await tx.select<{ field: string; hlc: string; base_hlc: string | null }>('SELECT field, hlc, base_hlc FROM sync_field_clock WHERE table_name = ? AND row_id = ?', [t.name, rowId])).map((c) => [
      c.field,
      { hlc: c.hlc as Hlc, base: c.base_hlc as Hlc | null },
    ]),
  );
  const pending = new Set((await tx.select<{ field: string }>('SELECT field FROM sync_outbox WHERE table_name = ? AND row_id = ?', [t.name, rowId])).map((p) => p.field));
  const values = new Map<string, SyncValue>(fields.map((f) => [f.name, (row[f.name] ?? null) as SyncValue]));
  return { row: { hlc: row['hlc'] as Hlc, values, clocks, pending }, tombstone: null, missingParents };
}

/** Écrit la décision (noms du catalogue seulement : `t` et les colonnes de `decision`, déjà cherchées dans le catalogue). */
async function writeDecision(tx: SqlExecutor, t: SyncTable, tableName: string, rowId: string, d: ReintegrationDecision, now: IsoDateTime): Promise<void> {
  const cols = [...d.values.keys()];
  if (d.write === 'insert' && d.meta) {
    const params: SqlValue[] = [rowId, ...cols.map((name) => d.values.get(name) ?? null), d.meta.updatedAt, d.meta.deviceId, d.meta.hlc];
    await tx.execute(`INSERT INTO ${t.name} (${[t.key, ...cols, 'updated_at', 'device_id', 'hlc'].join(', ')}) VALUES (${marks(params.length)})`, params);
  }
  if (d.write === 'update') {
    // Repli « * » écrit avant que le hlc de la ligne ne bouge.
    for (const clock of d.clocks.filter((c) => c.field === '*')) await upsertClock(tx, t, rowId, clock);
    const meta = d.meta ? [d.meta.updatedAt, d.meta.deviceId, d.meta.hlc] : [];
    const sets = [...cols.map((name) => `${name} = ?`), ...(d.meta ? ['updated_at = ?', 'device_id = ?', 'hlc = ?'] : [])];
    await tx.execute(`UPDATE ${t.name} SET ${sets.join(', ')} WHERE ${t.key} = ?`, [...cols.map((name) => d.values.get(name) ?? null), ...meta, rowId]);
  }
  for (const clock of d.clocks.filter((c) => d.write === 'insert' || c.field !== '*')) await upsertClock(tx, t, rowId, clock);
  for (const field of d.dropPending) await tx.execute('DELETE FROM sync_outbox WHERE table_name = ? AND row_id = ? AND field = ?', [t.name, rowId, field]);
  for (const { field, conflict: c } of d.conflicts) {
    await tx.execute(
      `INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc, detected_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM conflict_log WHERE table_name = ? AND row_id = ? AND field = ? AND kept_hlc = ? AND discarded_hlc = ?)`,
      [t.name, rowId, field, JSON.stringify(c.kept.value), JSON.stringify(c.discarded.value), c.kept.device, c.discarded.device, c.kept.hlc, c.discarded.hlc, now, t.name, rowId, field, c.kept.hlc, c.discarded.hlc],
    );
  }
  for (const field of d.remove) await tx.execute('DELETE FROM sync_unknown WHERE table_name = ? AND row_id = ? AND field = ?', [tableName, rowId, field]);
}

async function upsertClock(tx: SqlExecutor, t: SyncTable, id: string, clock: { readonly field: string; readonly hlc: Hlc; readonly base: Hlc | null }): Promise<void> {
  await tx.execute(
    `INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc`,
    [t.name, id, clock.field, clock.hlc, clock.base],
  );
}

/** Réintègre les champs gardés d'une ligne ; `tableName` et `rowId` sont des valeurs reçues, jamais des identifiants SQL. */
async function reintegrateRow(tx: SqlExecutor, catalogue: UnknownCatalogue, t: SyncTable, tableName: string, rowId: string, now: IsoDateTime): Promise<RowOutcome> {
  if (!isValidRowId(t, rowId)) return NOTHING;
  if (t.idKind === 'setting' && catalogue.settingScope(rowId) !== 'shared') return NOTHING;
  const stored = await tx.select<StoredUnknown & Record<string, SqlValue>>('SELECT field, value, hlc, base_hlc FROM sync_unknown WHERE table_name = ? AND row_id = ? ORDER BY field', [tableName, rowId]);
  const fields = keptFieldsOf(t, (name) => catalogue.column(t.name, name), stored);
  if (fields.length === 0) return NOTHING;
  const local = await readRow(tx, catalogue, t, rowId, fields);
  const decision = decideReintegration({ fields, columns: t.columns.map((c) => c.name), ...local });
  await writeDecision(tx, t, tableName, rowId, decision, now);
  return { reintegrated: decision.reintegrated, superseded: decision.superseded };
}

const saveFailure = (db: SqlExecutor, failure: ReintegrationFailure): Promise<unknown> =>
  db.execute('INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [REINTEGRATION_FAILURE_META, JSON.stringify(failure)]);

/**
 * Échec global (transaction refusée, disque plein, lecture impossible…) : l'échec est enregistré **au mieux** pour rester visible dans
 * l'app (exigence d'Ali), avec toutes les lignes gardées comptées (on ne sait pas lesquelles étaient réintégrables) ; puis l'erreur repart
 * (bootstrap.ts la journalise, l'app démarre). Si l'enregistrement échoue aussi, il est abandonné sans masquer l'erreur d'origine.
 */
export const reintegrateUnknownFields: ReintegrateUnknownFields = async (db, options) => {
  try {
    return await reintegrateAll(db, options);
  } catch (error) {
    try {
      const n = Number((await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_unknown'))[0]?.n ?? 0);
      await saveFailure(db, { fields: Math.max(1, n), tables: [], at: options.now, errors: [error instanceof Error ? error.name : 'Error'] });
    } catch {
      // Enregistrement impossible : l'erreur d'origine est remontée telle quelle.
    }
    throw error;
  }
};

const reintegrateAll: ReintegrateUnknownFields = async (db, options) => {
  const catalogue = options.catalogue ?? DEFAULT_CATALOGUE;
  const pageSize = Math.max(1, options.pageSize ?? 200);
  let reintegrated = 0;
  let superseded = 0;
  /** Lignes en échec dans cet appel : plus retentées avant le démarrage suivant. */
  const failed = new Set<string>();
  /** Échecs sans contenu (exigence d'Ali : visible dans l'app) : champs restés par table du catalogue, noms d'erreur. */
  const failedFields = new Map<string, number>();
  const errorNames = new Set<string>();
  for (let progress = true; progress; ) {
    progress = false;
    // Tables dans l'ordre parent → enfant (rang du catalogue) ; une table hors du catalogue n'a rien à réintégrer.
    const tables = (await db.select<{ table_name: string }>('SELECT DISTINCT table_name FROM sync_unknown'))
      .map((r) => r.table_name)
      .filter((name) => catalogue.table(name) !== undefined)
      .sort((a, b) => tableRank(a) - tableRank(b) || (a < b ? -1 : 1));
    for (const tableName of tables) {
      const t = catalogue.table(tableName) as SyncTable;
      let after: string | null = null;
      for (;;) {
        const ids: string[] = (
          await db.select<{ row_id: string }>(
            after === null
              ? 'SELECT DISTINCT row_id FROM sync_unknown WHERE table_name = ? ORDER BY row_id LIMIT ?'
              : 'SELECT DISTINCT row_id FROM sync_unknown WHERE table_name = ? AND row_id > ? ORDER BY row_id LIMIT ?',
            after === null ? [tableName, pageSize] : [tableName, after, pageSize],
          )
        ).map((r) => r.row_id);
        const last = ids.at(-1);
        if (last === undefined) break;
        after = last;
        const page = await db.transaction(async (tx) => {
          await tx.execute('INSERT OR IGNORE INTO sync_guard (id) VALUES (1)');
          let r = 0;
          let s = 0;
          for (const rowId of ids) {
            const key = `${tableName}\u0000${rowId}`;
            if (failed.has(key)) continue;
            // Chaque ligne dans son point de sauvegarde : un échec n'annule qu'elle (ses champs restent), jamais la page ni les suivantes.
            await tx.execute('SAVEPOINT reintegrate_row');
            try {
              const outcome = await reintegrateRow(tx, catalogue, t, tableName, rowId, options.now);
              await tx.execute('RELEASE reintegrate_row');
              r += outcome.reintegrated;
              s += outcome.superseded;
            } catch (error) {
              await tx.execute('ROLLBACK TO reintegrate_row');
              await tx.execute('RELEASE reintegrate_row');
              failed.add(key);
              const name = error instanceof Error ? error.name : 'Error';
              errorNames.add(name);
              // « N éléments » : seuls les champs réintégrables de la ligne (un champ encore inconnu attend normalement, il n'est pas en échec).
              const stored = await tx.select<StoredUnknown & Record<string, SqlValue>>('SELECT field, value, hlc, base_hlc FROM sync_unknown WHERE table_name = ? AND row_id = ?', [tableName, rowId]);
              const n = keptFieldsOf(t, (name) => catalogue.column(t.name, name), stored).length;
              failedFields.set(t.name, (failedFields.get(t.name) ?? 0) + n);
              options.onRowError?.(name);
            }
          }
          await tx.execute('DELETE FROM sync_guard');
          return { r, s };
        });
        reintegrated += page.r;
        superseded += page.s;
        if (page.r + page.s > 0) progress = true;
        if (ids.length < pageSize) break;
      }
    }
  }
  // État d'échec gardé pour l'affichage (survit au redémarrage) ; effacé dès qu'un démarrage n'a plus d'échec.
  const fields = [...failedFields.values()].reduce((a, b) => a + b, 0);
  const failure: ReintegrationFailure | null = failed.size > 0 ? { fields: Math.max(1, fields), tables: [...failedFields.keys()].sort(), at: options.now, errors: [...errorNames].sort() } : null;
  if (failure) await saveFailure(db, failure);
  else await db.execute('DELETE FROM sync_meta WHERE key = ?', [REINTEGRATION_FAILURE_META]);
  const remaining = Number((await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM sync_unknown'))[0]?.n ?? 0);
  return { reintegrated, superseded, remaining };
};
