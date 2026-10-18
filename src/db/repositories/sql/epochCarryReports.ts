import type { EpochCarryAuthorCount, EpochCarryNamedItem, EpochCarryParentItem, EpochCarryReport, EpochCarryReportBody, EpochCarryReportHead } from '../../../domain/sync/epochCarryReport';
import type { DeviceId, IsoDateTime } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { EpochCarryReportRepository } from '../epochCarryReportRepository';

/**
 * Implémentation SQL de `EpochCarryReportRepository` (Y-TECH-05, migration 0019). Chargée à la demande (`Repositories.carryReports()`),
 * jamais dans le JavaScript de départ. Colonnes JSON lues défensivement : une valeur illisible est lue vide et le compte rendu marqué
 * `damaged` (signalé à l'écran), jamais un échec de lecture.
 */

const COLUMNS = 'id, epoch, cause, reporter, opener, mode, authors, restored, recreated, parent_replaced, overflow, banner, created_at, acknowledged_at';

function parseList<T>(raw: unknown, damaged: { value: boolean }): T[] {
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (Array.isArray(value)) return value as T[];
  } catch {
    // signalé par `damaged`
  }
  damaged.value = true;
  return [];
}

function rowToReport(r: SqlRow): EpochCarryReport {
  const damaged = { value: false };
  return {
    id: r['id'] as number,
    epoch: r['epoch'] as string,
    cause: r['cause'] as EpochCarryReport['cause'],
    reporter: r['reporter'] as DeviceId,
    opener: r['opener'] as DeviceId,
    mode: r['mode'] as EpochCarryReport['mode'],
    authors: parseList<EpochCarryAuthorCount>(r['authors'], damaged),
    restored: parseList<EpochCarryNamedItem>(r['restored'], damaged),
    recreated: parseList<EpochCarryNamedItem>(r['recreated'], damaged),
    parentReplaced: parseList<EpochCarryParentItem>(r['parent_replaced'], damaged),
    overflow: Number(r['overflow']),
    banner: r['banner'] === 1,
    createdAt: r['created_at'] as IsoDateTime,
    acknowledgedAt: (r['acknowledged_at'] as IsoDateTime | null) ?? null,
    damaged: damaged.value,
  };
}

export function createEpochCarryReportRepository(db: SqlExecutor): EpochCarryReportRepository {
  return {
    async create(head: EpochCarryReportHead) {
      const done = await db.execute('INSERT INTO epoch_carry_report (epoch, cause, reporter, opener, mode, created_at) VALUES (?, ?, ?, ?, ?, ?)', [head.epoch, head.cause, head.reporter, head.opener, head.mode, head.createdAt]);
      if (done.lastInsertId !== null) return done.lastInsertId;
      const rows = await db.select<{ id: number }>('SELECT MAX(id) AS id FROM epoch_carry_report');
      return rows[0]?.id as number;
    },
    async get(id) {
      const rows = await db.select(`SELECT ${COLUMNS} FROM epoch_carry_report WHERE id = ?`, [id]);
      return rows[0] ? rowToReport(rows[0]) : null;
    },
    async save(id, body: EpochCarryReportBody, banner) {
      const authors = [...body.authors].sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
      await db.execute('UPDATE epoch_carry_report SET authors = ?, restored = ?, recreated = ?, parent_replaced = ?, overflow = ?, banner = ? WHERE id = ?', [
        JSON.stringify(authors),
        JSON.stringify(body.restored),
        JSON.stringify(body.recreated),
        JSON.stringify(body.parentReplaced),
        body.overflow,
        banner ? 1 : 0,
        id,
      ]);
    },
    async list(limit) {
      return (await db.select(`SELECT ${COLUMNS} FROM epoch_carry_report ORDER BY id DESC LIMIT ?`, [limit])).map(rowToReport);
    },
    async unacknowledged() {
      return (await db.select(`SELECT ${COLUMNS} FROM epoch_carry_report WHERE acknowledged_at IS NULL ORDER BY id DESC`)).map(rowToReport);
    },
    async acknowledge(id, at) {
      return (await db.execute('UPDATE epoch_carry_report SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL', [at, id])).rowsAffected > 0;
    },
    async prune(keep) {
      return (await db.execute('DELETE FROM epoch_carry_report WHERE acknowledged_at IS NOT NULL AND id NOT IN (SELECT id FROM epoch_carry_report ORDER BY id DESC LIMIT ?)', [keep])).rowsAffected;
    },
  };
}
