import { parseIcon } from '../../../domain/model';
import type { SearchHit, SearchKind, SearchStatus } from '../../../domain/search';
import type { LocalDate, LocalTime, ProjectId, SpaceId } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { SearchQueryInput, SearchRepository } from '../searchRepository';
import { SEARCH_REBUILD_STATEMENTS } from './searchIndexSql';

interface HitRow extends SqlRow {
  readonly kind: string;
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly status: string | null;
  readonly space_id: string;
  readonly project_id: string | null;
  readonly someday: number;
  readonly icon: string | null;
  readonly items: string | null;
  readonly items_checked: number;
  readonly repeat: string | null;
}

/** Colonnes communes de chaque branche (même ordre, pour `UNION ALL`). */
const COLUMNS = 'kind, id, title, note, date, time, status, space_id, project_id, someday, icon, items, items_checked, repeat, score';

/** Une branche par type : jointure de l'index sur la table d'origine (lignes vivantes) et filtre d'espace dans la requête. */
function branches(spaceClause: string): string {
  return [
    `SELECT 'task' AS kind, t.id AS id, t.title AS title, t.note AS note, t.date AS date, t.time AS time, t.status AS status,
            t.space_id AS space_id, t.project_id AS project_id, t.someday AS someday, t.icon AS icon, NULL AS items, 0 AS items_checked,
            NULL AS repeat, h.score AS score
       FROM hits h JOIN task t ON h.type = 'task' AND t.id = h.ref_id
      WHERE t.deleted_at IS NULL ${spaceClause.replaceAll('{col}', 't.space_id')}`,
    `SELECT 'checklist', c.id, c.title, '', c.date, NULL, NULL, c.space_id, NULL, 0, c.icon,
            (SELECT group_concat(i.text, char(10)) FROM checklist_item i WHERE i.checklist_id = c.id AND i.deleted_at IS NULL),
            (SELECT COUNT(*) FROM checklist_item i WHERE i.checklist_id = c.id AND i.deleted_at IS NULL AND i.checked = 1),
            NULL, h.score
       FROM hits h JOIN checklist c ON h.type = 'checklist' AND c.id = h.ref_id
      WHERE c.deleted_at IS NULL ${spaceClause.replaceAll('{col}', 'c.space_id')}`,
    `SELECT 'event', e.id, e.title, '', e.start_date, e.start_time, NULL, e.space_id, NULL, 0, e.icon, NULL, 0, e.repeat, h.score
       FROM hits h JOIN event e ON h.type = 'event' AND e.id = h.ref_id
      WHERE e.deleted_at IS NULL ${spaceClause.replaceAll('{col}', 'e.space_id')}`,
    `SELECT 'routine', r.id, r.title, '', NULL, r.time, CASE WHEN r.archived = 1 THEN 'archived' WHEN r.paused = 1 THEN 'paused' ELSE NULL END,
            r.space_id, NULL, 0, r.icon, NULL, 0, NULL, h.score
       FROM hits h JOIN routine r ON h.type = 'routine' AND r.id = h.ref_id
      WHERE r.deleted_at IS NULL ${spaceClause.replaceAll('{col}', 'r.space_id')}`,
    `SELECT 'goal', g.id, g.title, '', g.week_start, NULL, g.status, g.space_id, NULL, 0, g.icon, NULL, 0, NULL, h.score
       FROM hits h JOIN goal g ON h.type = 'goal' AND g.id = h.ref_id
      WHERE g.deleted_at IS NULL ${spaceClause.replaceAll('{col}', 'g.space_id')}`,
  ].join('\nUNION ALL\n');
}

function rowToHit(row: HitRow): SearchHit {
  return {
    kind: row.kind as SearchKind,
    id: row.id,
    title: row.title,
    note: row.note,
    date: row.date as LocalDate | null,
    time: row.time as LocalTime | null,
    status: row.status as SearchStatus | null,
    spaceId: row.space_id as SpaceId,
    projectId: row.project_id as ProjectId | null,
    someday: row.someday === 1,
    icon: parseIcon(row.icon),
    items: row.items === null ? [] : row.items.split('\n'),
    itemsChecked: row.items_checked,
    repeat: row.repeat,
  };
}

/** Compte des éléments vivants des cinq types indexés ; à comparer au nombre de lignes de `search_index_doc`. */
const STALE_SQL = `
  SELECT (SELECT COUNT(*) FROM search_index_doc) AS indexed,
         (SELECT COUNT(*) FROM task WHERE deleted_at IS NULL) + (SELECT COUNT(*) FROM routine WHERE deleted_at IS NULL)
       + (SELECT COUNT(*) FROM event WHERE deleted_at IS NULL) + (SELECT COUNT(*) FROM goal WHERE deleted_at IS NULL)
       + (SELECT COUNT(*) FROM checklist WHERE deleted_at IS NULL) AS alive`;

export function createSearchRepository(db: SqlExecutor): SearchRepository {
  return {
    async query(input: SearchQueryInput): Promise<readonly SearchHit[]> {
      const params: SqlValue[] = [input.match];
      const spaceClause = input.space === 'all' ? '' : 'AND {col} = ?';
      // Le filtre d'espace est répété dans chacune des cinq branches : un paramètre par branche.
      if (input.space !== 'all') for (let i = 0; i < 5; i += 1) params.push(input.space);
      params.push(input.limit);
      const rows = await db.select<HitRow>(
        `WITH hits AS MATERIALIZED (
           SELECT type, ref_id, bm25(search_index, 0.0, 0.0, 5.0, 1.0) AS score FROM search_index WHERE search_index MATCH ?
         )
         SELECT ${COLUMNS} FROM (${branches(spaceClause)}) ORDER BY score, kind, id LIMIT ?`,
        params,
      );
      return rows.map(rowToHit);
    },

    async rebuild(): Promise<void> {
      for (const statement of SEARCH_REBUILD_STATEMENTS) await db.execute(statement);
    },

    async isStale(): Promise<boolean> {
      const row = (await db.select<{ indexed: number; alive: number }>(STALE_SQL))[0];
      return row === undefined || row.indexed !== row.alive;
    },
  };
}
