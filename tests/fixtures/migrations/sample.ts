import type { Migration } from '../../../src/db/migrator';

/** Migrations d'exemple pour tester le lanceur (aucune table métier). */
export const sampleMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'demo_note',
    statements: ['CREATE TABLE demo_note (id TEXT PRIMARY KEY, body TEXT NOT NULL)'],
  },
  {
    version: 2,
    name: 'demo_note_search',
    statements: [
      'ALTER TABLE demo_note ADD COLUMN tag TEXT',
      "CREATE VIRTUAL TABLE demo_note_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')",
    ],
  },
];
