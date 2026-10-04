/**
 * Reconstruction complète de l'index de recherche (`SearchRepository.rebuild`). Mêmes règles que les déclencheurs de la migration
 * 0011 (une migration publiée ne change plus : cette liste évolue avec le schéma, un test compare les deux résultats).
 * Titre et note des tâches ; titre des routines, événements locaux, objectifs ; titre d'une checklist et texte de ses items.
 */
const checklistBody = (id: string): string =>
  `(SELECT COALESCE(group_concat(text, char(10)), '') FROM checklist_item WHERE checklist_id = ${id} AND deleted_at IS NULL)`;

/** [type, table, titre, corps]. */
const SOURCES: readonly (readonly [string, string, string, string])[] = [
  ['task', 'task', 't.title', 't.note'],
  ['routine', 'routine', 't.title', "''"],
  ['event', 'event', 't.title', "''"],
  ['goal', 'goal', 't.title', "''"],
  ['checklist', 'checklist', 't.title', checklistBody('t.id')],
];

export const SEARCH_REBUILD_STATEMENTS: readonly string[] = [
  'DELETE FROM search_index',
  'DELETE FROM search_index_doc',
  ...SOURCES.flatMap(([type, table, title, body]) => [
    `INSERT INTO search_index_doc (type, ref_id) SELECT '${type}', id FROM ${table} WHERE deleted_at IS NULL`,
    `INSERT INTO search_index (rowid, type, ref_id, title, body)
     SELECT d.id, '${type}', t.id, ${title}, ${body}
     FROM ${table} t JOIN search_index_doc d ON d.type = '${type}' AND d.ref_id = t.id WHERE t.deleted_at IS NULL`,
  ]),
];
