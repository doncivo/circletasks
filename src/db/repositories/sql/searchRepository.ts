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

interface Branch {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

type Condition = readonly [sql: string, params: readonly SqlValue[]];

const dateIn = (column: string, range: { readonly from: string; readonly to: string } | null): Condition[] =>
  range ? [[`${column} BETWEEN ? AND ?`, [range.from, range.to]]] : [];

/**
 * Une branche par type cherché : jointure de l'index sur la table d'origine (lignes vivantes), puis les filtres dans la requête
 * (espace, projet, statut, période). Chaque filtre ajoute sa condition ET ses paramètres, dans l'ordre d'apparition.
 */
function buildBranch(kind: SearchKind, input: SearchQueryInput): Branch {
  const params: SqlValue[] = [];
  const where = (alias: string, extra: readonly Condition[] = []): string => {
    const conditions = [`${alias}.deleted_at IS NULL`];
    if (input.space !== 'all') {
      conditions.push(`${alias}.space_id = ?`);
      params.push(input.space);
    }
    for (const [condition, values] of extra) {
      conditions.push(condition);
      params.push(...values);
    }
    return conditions.join(' AND ');
  };

  switch (kind) {
    case 'task': {
      const extra: Condition[] = [
        ...(input.projectId ? ([['t.project_id = ?', [input.projectId]]] as Condition[]) : []),
        ...(input.statuses ? ([['t.status = ?', [input.statuses.task]]] as Condition[]) : []),
        ...dateIn('t.date', input.period),
      ];
      const sql = `SELECT 'task' AS kind, t.id AS id, t.title AS title, t.note AS note, t.date AS date, t.time AS time, t.status AS status,
            t.space_id AS space_id, t.project_id AS project_id, t.someday AS someday, t.icon AS icon, NULL AS items, 0 AS items_checked,
            NULL AS repeat, h.score AS score
       FROM hits h JOIN task t ON h.type = 'task' AND t.id = h.ref_id
      WHERE ${where('t', extra)}`;
      return { sql, params };
    }
    case 'checklist': {
      const sql = `SELECT 'checklist', c.id, c.title, '', c.date, NULL, NULL, c.space_id, NULL, 0, c.icon,
            (SELECT group_concat(i.text, char(10)) FROM checklist_item i WHERE i.checklist_id = c.id AND i.deleted_at IS NULL),
            (SELECT COUNT(*) FROM checklist_item i WHERE i.checklist_id = c.id AND i.deleted_at IS NULL AND i.checked = 1),
            NULL, h.score
       FROM hits h JOIN checklist c ON h.type = 'checklist' AND c.id = h.ref_id
      WHERE ${where('c', dateIn('c.date', input.period))}`;
      return { sql, params };
    }
    case 'event': {
      const sql = `SELECT 'event', e.id, e.title, '', e.start_date, e.start_time, NULL, e.space_id, NULL, 0, e.icon, NULL, 0, e.repeat, h.score
       FROM hits h JOIN event e ON h.type = 'event' AND e.id = h.ref_id
      WHERE ${where('e', dateIn('e.start_date', input.period))}`;
      return { sql, params };
    }
    case 'routine': {
      const sql = `SELECT 'routine', r.id, r.title, '', NULL, r.time, CASE WHEN r.archived = 1 THEN 'archived' WHEN r.paused = 1 THEN 'paused' ELSE NULL END,
            r.space_id, NULL, 0, r.icon, NULL, 0, NULL, h.score
       FROM hits h JOIN routine r ON h.type = 'routine' AND r.id = h.ref_id
      WHERE ${where('r')}`;
      return { sql, params };
    }
    case 'goal': {
      const extra: Condition[] = [...(input.statuses ? ([['g.status = ?', [input.statuses.goal]]] as Condition[]) : []), ...dateIn('g.week_start', input.goalPeriod)];
      const sql = `SELECT 'goal', g.id, g.title, '', g.week_start, NULL, g.status, g.space_id, NULL, 0, g.icon, NULL, 0, NULL, h.score
       FROM hits h JOIN goal g ON h.type = 'goal' AND g.id = h.ref_id
      WHERE ${where('g', extra)}`;
      return { sql, params };
    }
  }
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
      if (input.kinds.length === 0) return [];
      const branches = input.kinds.map((kind) => buildBranch(kind, input));
      const rows = await db.select<HitRow>(
        `WITH hits AS MATERIALIZED (
           SELECT type, ref_id, bm25(search_index, 0.0, 0.0, 5.0, 1.0) AS score FROM search_index WHERE search_index MATCH ?
         ), merged(${COLUMNS}) AS (${branches.map((branch) => branch.sql).join('\nUNION ALL\n')})
         SELECT ${COLUMNS} FROM merged ORDER BY score, kind, id LIMIT ?`,
        [input.match, ...branches.flatMap((branch) => branch.params), input.limit],
      );
      return rows.map(rowToHit);
    },

    async rebuild(): Promise<void> {
      for (const statement of SEARCH_REBUILD_STATEMENTS) await db.execute(statement);
    },

    // Comparaison par nombre de lignes seulement : une divergence de contenu n'est pas détectée, acceptable car les déclencheurs maintiennent l'index.
    async isStale(): Promise<boolean> {
      const row = (await db.select<{ indexed: number; alive: number }>(STALE_SQL))[0];
      return row === undefined || row.indexed !== row.alive;
    },
  };
}
