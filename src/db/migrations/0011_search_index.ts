import type { Migration } from '../migrator';

/**
 * RC-01 : index de recherche plein texte (PRD section 6, M14), table virtuelle FTS5 `search_index` locale, NON synchronisée (jamais
 * écrite par la synchro : elle se reconstruit sur chaque appareil).
 * - colonnes : `type` et `ref_id` non indexées (type de l'élément et identifiant de sa ligne), `title` et `body` indexées ;
 *   tokeniseur `unicode61 remove_diacritics 2` : casse et accents ignorés ;
 * - `search_index_doc` relie un élément (type, ref_id) au rowid de sa ligne FTS : mise à jour et suppression se font par rowid,
 *   sans parcourir l'index (5 000 tâches) ;
 * - contenu : titre et note des tâches, titre des routines (la table `routine` n'a pas de note), des événements locaux et des
 *   objectifs, titre d'une checklist (titre) et texte de ses items (corps, un item par ligne). Les événements externes et les fériés
 *   sont d'autres tables : jamais indexés ;
 * - maintenue par déclencheurs, donc aussi pour les écritures de la synchro : une ligne supprimée logiquement (`deleted_at`) quitte
 *   l'index, une restauration (`deleted_at` remis à NULL) l'y remet ; chaque déclencheur efface avant d'écrire (`INSERT OR REPLACE`
 *   d'un appareil à l'autre ne crée jamais de doublon) ;
 * - la base existante est indexée à la fin de la migration (même requêtes que `SearchRepository.rebuild`, src/db/repositories/sql).
 * Rejouable : tout est en `IF NOT EXISTS`, la reconstruction finale est idempotente.
 */

/** Efface la ligne d'index d'un élément (par identifiant SQL `ref`) ; sans effet si elle n'existe pas. */
const dropEntry = (type: string, ref: string): string =>
  `DELETE FROM search_index WHERE rowid IN (SELECT id FROM search_index_doc WHERE type = '${type}' AND ref_id = ${ref});
   DELETE FROM search_index_doc WHERE type = '${type}' AND ref_id = ${ref};`;

/** Écrit la ligne d'index d'un élément vivant (`alive` : condition SQL), après `dropEntry`. */
const putEntry = (type: string, ref: string, alive: string, title: string, body: string): string =>
  `INSERT INTO search_index_doc (type, ref_id) SELECT '${type}', ${ref} WHERE ${alive};
   INSERT INTO search_index (rowid, type, ref_id, title, body) SELECT last_insert_rowid(), '${type}', ${ref}, ${title}, ${body} WHERE ${alive};`;

/** Trois déclencheurs (insertion, modification des colonnes indexées, suppression physique) d'une table à titre et corps simples. */
function triggers(table: string, type: string, columns: string, title: string, body: string): string[] {
  const refresh = (row: 'NEW'): string => `${dropEntry(type, `${row}.id`)} ${putEntry(type, `${row}.id`, `${row}.deleted_at IS NULL`, title, body)}`;
  return [
    `CREATE TRIGGER IF NOT EXISTS search_${table}_ai AFTER INSERT ON ${table} BEGIN ${refresh('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_${table}_au AFTER UPDATE OF ${columns}, deleted_at ON ${table} BEGIN ${refresh('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_${table}_ad AFTER DELETE ON ${table} BEGIN ${dropEntry(type, 'OLD.id')} END`,
  ];
}

/** Corps d'une checklist : texte de ses items vivants, un par ligne. */
const checklistBody = (id: string): string =>
  `(SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = ${id} AND deleted_at IS NULL)`;

/** Réindexe une checklist entière (titre + items), à partir de son identifiant SQL. */
const refreshChecklist = (id: string): string =>
  `${dropEntry('checklist', id)}
   INSERT INTO search_index_doc (type, ref_id) SELECT 'checklist', c.id FROM checklist c WHERE c.id = ${id} AND c.deleted_at IS NULL;
   INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, 'checklist', c.id, c.title, ${checklistBody('c.id')}
     FROM checklist c JOIN search_index_doc d ON d.type = 'checklist' AND d.ref_id = c.id WHERE c.id = ${id} AND c.deleted_at IS NULL;`;

/** Reconstruction complète (base existante) : mêmes règles que les déclencheurs. [type, table, titre, corps] */
const SOURCES: readonly (readonly [string, string, string, string])[] = [
  ['task', 'task', 't.title', 't.note'],
  ['routine', 'routine', 't.title', "''"],
  ['event', 'event', 't.title', "''"],
  ['goal', 'goal', 't.title', "''"],
  ['checklist', 'checklist', 't.title', checklistBody('t.id')],
];

export const REBUILD_STATEMENTS: readonly string[] = [
  'DELETE FROM search_index',
  'DELETE FROM search_index_doc',
  ...SOURCES.flatMap(([type, table, title, body]) => [
    `INSERT INTO search_index_doc (type, ref_id) SELECT '${type}', id FROM ${table} WHERE deleted_at IS NULL`,
    `INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, '${type}', t.id, ${title}, ${body}
     FROM ${table} t JOIN search_index_doc d ON d.type = '${type}' AND d.ref_id = t.id WHERE t.deleted_at IS NULL`,
  ]),
];

export const migration0011SearchIndex: Migration = {
  version: 11,
  name: 'search_index',
  statements: [
    `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      type UNINDEXED, ref_id UNINDEXED, title, body,
      tokenize = 'unicode61 remove_diacritics 2'
    )`,
    `CREATE TABLE IF NOT EXISTS search_index_doc (
      id     INTEGER PRIMARY KEY,
      type   TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      UNIQUE (type, ref_id)
    )`,
    ...triggers('task', 'task', 'title, note', 'NEW.title', 'NEW.note'),
    ...triggers('routine', 'routine', 'title', 'NEW.title', "''"),
    ...triggers('event', 'event', 'title', 'NEW.title', "''"),
    ...triggers('goal', 'goal', 'title', 'NEW.title', "''"),
    // Checklist : le titre et les items vivent dans une seule ligne ; tout changement de l'un ou des autres la réécrit.
    `CREATE TRIGGER IF NOT EXISTS search_checklist_ai AFTER INSERT ON checklist BEGIN ${refreshChecklist('NEW.id')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_checklist_au AFTER UPDATE OF title, deleted_at ON checklist BEGIN ${refreshChecklist('NEW.id')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_checklist_ad AFTER DELETE ON checklist BEGIN ${dropEntry('checklist', 'OLD.id')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_checklist_item_ai AFTER INSERT ON checklist_item BEGIN ${refreshChecklist('NEW.checklist_id')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_checklist_item_au AFTER UPDATE OF text, deleted_at, checklist_id ON checklist_item BEGIN ${refreshChecklist('NEW.checklist_id')} ${refreshChecklist('OLD.checklist_id')} END`,
    `CREATE TRIGGER IF NOT EXISTS search_checklist_item_ad AFTER DELETE ON checklist_item BEGIN ${refreshChecklist('OLD.checklist_id')} END`,
    ...REBUILD_STATEMENTS,
  ],
};
