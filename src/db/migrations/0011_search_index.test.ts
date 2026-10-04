import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../seed/defaultSpaces';
import { migrations } from './index';

const STAMP = ['2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'] as const;

async function addTask(db: SqlDriver, id: string, title: string, note = ''): Promise<void> {
  await db.execute(`INSERT INTO task (id, space_id, title, note, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, SPACE_PRO_ID, title, note, ...STAMP]);
}

async function hits(db: SqlDriver, query: string): Promise<string[]> {
  const rows = await db.select<{ type: string; ref_id: string }>('SELECT type, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY ref_id', [query]);
  return rows.map((row) => `${row.type}:${row.ref_id}`);
}

describe('migration 0011 (RC-01) : index de recherche FTS5', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('indexe la création, le renommage, la suppression logique et la restauration d’une tâche', async () => {
    await migrate(db, migrations);
    await addTask(db, 't1', 'Envoyer la facture', 'contester le devis');
    expect(await hits(db, 'facture')).toEqual(['task:t1']);
    expect(await hits(db, 'FACTURE')).toEqual(['task:t1']);
    expect(await hits(db, 'factüre')).toEqual(['task:t1']);
    expect(await hits(db, '"fact"*')).toEqual(['task:t1']);
    expect(await hits(db, 'devis')).toEqual(['task:t1']);

    await db.execute("UPDATE task SET title = 'Payer le loyer' WHERE id = 't1'");
    expect(await hits(db, 'facture')).toEqual([]);
    expect(await hits(db, 'loyer')).toEqual(['task:t1']);

    await db.execute("UPDATE task SET deleted_at = '2026-10-02T08:00:00.000Z' WHERE id = 't1'");
    expect(await hits(db, 'loyer')).toEqual([]);
    await db.execute("UPDATE task SET deleted_at = NULL WHERE id = 't1'");
    expect(await hits(db, 'loyer')).toEqual(['task:t1']);

    await db.execute("DELETE FROM task WHERE id = 't1'");
    expect(await hits(db, 'loyer')).toEqual([]);
    expect(await db.select('SELECT * FROM search_index_doc')).toEqual([]);
  });

  it('une ligne remplacée (INSERT OR REPLACE de la synchro) ne crée aucun doublon', async () => {
    await migrate(db, migrations);
    await addTask(db, 't1', 'Facture');
    await db.execute(
      `INSERT OR REPLACE INTO task (id, space_id, title, note, created_at, updated_at, device_id, hlc) VALUES ('t1', ?, 'Facture bis', '', ?, ?, ?, ?)`,
      [SPACE_PRO_ID, ...STAMP],
    );
    expect(await hits(db, 'facture')).toEqual(['task:t1']);
    expect(await db.select('SELECT * FROM search_index_doc')).toHaveLength(1);
  });

  it('indexe routines, événements locaux et objectifs par leur titre ; les événements externes et fériés ne le sont pas', async () => {
    await migrate(db, migrations);
    await db.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r1', ?, 'Boire de l’eau', 'daily', '2026-09-01', ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    await db.execute(`INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e1', ?, 'Réunion équipe', '2026-10-05', '2026-10-05', ?, ?, ?, ?)`, [SPACE_PRO_ID, ...STAMP]);
    await db.execute(`INSERT INTO goal (id, space_id, week_start, title, created_at, updated_at, device_id, hlc) VALUES ('g1', ?, '2026-09-28', 'Finaliser le PRD', ?, ?, ?, ?)`, [SPACE_PRO_ID, ...STAMP]);
    expect(await hits(db, 'eau')).toEqual(['routine:r1']);
    expect(await hits(db, 'reunion')).toEqual(['event:e1']);
    expect(await hits(db, 'prd')).toEqual(['goal:g1']);
    await db.execute("UPDATE goal SET status = 'achieved' WHERE id = 'g1'");
    expect(await hits(db, 'prd')).toEqual(['goal:g1']);
    expect(await db.select("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_%' AND (name LIKE '%external%' OR name LIKE '%holiday%')")).toEqual([]);
  });

  it('une checklist se trouve par son titre et par le texte de ses items ; items supprimés et checklist supprimée en sortent', async () => {
    await migrate(db, migrations);
    await db.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Valise été', ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    expect(await hits(db, 'valise')).toEqual(['checklist:c1']);
    await db.execute(`INSERT INTO checklist_item (id, checklist_id, text, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Crème solaire', ?, ?, ?, ?)`, [...STAMP]);
    await db.execute(`INSERT INTO checklist_item (id, checklist_id, text, created_at, updated_at, device_id, hlc) VALUES ('i2', 'c1', 'Maillot de bain', ?, ?, ?, ?)`, [...STAMP]);
    expect(await hits(db, 'creme')).toEqual(['checklist:c1']);
    expect(await hits(db, 'maillot')).toEqual(['checklist:c1']);
    await db.execute("UPDATE checklist_item SET text = 'Chapeau' WHERE id = 'i1'");
    expect(await hits(db, 'creme')).toEqual([]);
    expect(await hits(db, 'chapeau')).toEqual(['checklist:c1']);
    await db.execute("UPDATE checklist_item SET deleted_at = '2026-10-02T08:00:00.000Z' WHERE id = 'i2'");
    expect(await hits(db, 'maillot')).toEqual([]);
    await db.execute("UPDATE checklist SET title = 'Bagages' WHERE id = 'c1'");
    expect(await hits(db, 'valise')).toEqual([]);
    expect(await hits(db, 'bagages')).toEqual(['checklist:c1']);
    expect(await db.select('SELECT * FROM search_index_doc')).toHaveLength(1);
    await db.execute("UPDATE checklist SET deleted_at = '2026-10-02T08:00:00.000Z' WHERE id = 'c1'");
    expect(await hits(db, 'bagages')).toEqual([]);
    expect(await hits(db, 'chapeau')).toEqual([]);
  });

  it('base peuplée 0001 → 11 : les éléments existants sont indexés, les supprimés non, rejouable', async () => {
    await migrate(db, migrations.slice(0, 10));
    await addTask(db, 't1', 'Facture électricité');
    await addTask(db, 't2', 'Courses', 'acheter du café');
    await addTask(db, 't3', 'Facture supprimée');
    await db.execute("UPDATE task SET deleted_at = '2026-10-02T08:00:00.000Z' WHERE id = 't3'");
    await db.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Valise', ?, ?, ?, ?)`, [SPACE_PERSO_ID, ...STAMP]);
    await db.execute(`INSERT INTO checklist_item (id, checklist_id, text, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Brosse à dents', ?, ?, ?, ?)`, [...STAMP]);
    expect((await migrate(db, migrations.slice(0, 11))).applied).toEqual([11]);
    expect((await migrate(db, migrations)).applied).toEqual(migrations.slice(11).map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);
    expect(await hits(db, 'facture')).toEqual(['task:t1']);
    expect(await hits(db, 'cafe')).toEqual(['task:t2']);
    expect(await hits(db, 'brosse')).toEqual(['checklist:c1']);
    expect(await db.select('SELECT title FROM task ORDER BY id')).toHaveLength(3);
  });
});
