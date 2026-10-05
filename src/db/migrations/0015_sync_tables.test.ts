import { describe, expect, it } from 'vitest';
import { SHARED_SETTING_KEYS, SYNC_TABLES, publishedColumns } from '../../domain/sync/syncTables';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { CAPTURE_TABLES_V15, SHARED_SETTING_KEYS_V15, migration0015SyncTables } from './0015_sync_tables';
import { migrations } from './index';

const PRO = '00000000-0000-4000-8000-000000000001';
const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const h = (ms: number): string => `${String(ms).padStart(15, '0')}-0000-${DEV}`;
const AT = '2026-10-01T08:00:00.000Z';

async function freshDb(): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  await migrate(db, migrations);
  return db;
}

async function insertTask(db: SqlDriver, id: string, hlc: string): Promise<void> {
  await db.execute(
    'INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, PRO, 'Facture', AT, AT, DEV, hlc],
  );
}

const outbox = (db: SqlDriver) => db.select<{ table_name: string; row_id: string; field: string }>('SELECT table_name, row_id, field FROM sync_outbox ORDER BY seq');
const clocks = (db: SqlDriver) => db.select<{ field: string; hlc: string; base_hlc: string | null }>('SELECT field, hlc, base_hlc FROM sync_field_clock ORDER BY field');

describe('migration 0015 : tables et déclencheurs de synchro (Y-02 critère 4)', () => {
  it('numéro suivant, sans trou ; rejouable sans effet', async () => {
    expect(migration0015SyncTables.version).toBe(15);
    expect(migrations.map((m) => m.version)).toEqual([...Array(migrations.length).keys()].map((i) => i + 1));
    const db = await freshDb();
    expect((await migrate(db, migrations)).applied).toEqual([]);
    await db.close();
  });

  it('la copie figée des colonnes publiées est égale au catalogue (syncTables.ts)', () => {
    expect(CAPTURE_TABLES_V15.map(([t, key, cols]) => [t, key, [...cols]])).toEqual(SYNC_TABLES.map((t) => [t.name, t.key, [...publishedColumns(t)]]));
    expect([...SHARED_SETTING_KEYS_V15]).toEqual([...SHARED_SETTING_KEYS]);
  });

  it('le catalogue est égal au schéma : colonnes publiées + locales + techniques = PRAGMA table_info', async () => {
    const db = await freshDb();
    for (const t of SYNC_TABLES) {
      const info = await db.select<{ name: string }>(`PRAGMA table_info(${t.name})`);
      const actual = info.map((col) => col.name).sort();
      const technical = t.name === 'settings' ? ['updated_at', 'device_id', 'hlc', 'key'] : ['id', 'updated_at', 'device_id', 'hlc'];
      expect([...publishedColumns(t), ...t.local, ...technical].sort(), t.name).toEqual(actual);
    }
    await db.close();
  });

  it('base peuplée en version 14 : migrée sans perte, file vide, aucune horloge de champ', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 14));
    await insertTask(db, 't1', h(1));
    await migrate(db, migrations);
    expect(await db.select('SELECT id, title FROM task')).toEqual([{ id: 't1', title: 'Facture' }]);
    expect(await outbox(db)).toEqual([]);
    expect(await clocks(db)).toEqual([]);
    await db.close();
  });

  it('insertion : une entrée « * » ; modification : une entrée par colonne publiée changée, horloge et base du champ', async () => {
    const db = await freshDb();
    await insertTask(db, 't1', h(1));
    expect(await outbox(db)).toEqual([{ table_name: 'task', row_id: 't1', field: '*' }]);
    await db.execute('DELETE FROM sync_outbox');
    await db.execute("UPDATE task SET title = 'Loyer', updated_at = ?, hlc = ? WHERE id = 't1'", [AT, h(2)]);
    expect(await outbox(db)).toEqual([{ table_name: 'task', row_id: 't1', field: 'title' }]);
    // Repli « * » = hlc précédent de la ligne ; le champ modifié porte son hlc et sa base (valeur remplacée).
    expect(await clocks(db)).toEqual([
      { field: '*', hlc: h(1), base_hlc: null },
      { field: 'title', hlc: h(2), base_hlc: h(1) },
    ]);
    // Seconde modification avant publication : la base d'origine est gardée.
    await db.execute("UPDATE task SET title = 'Loyer bis', hlc = ? WHERE id = 't1'", [h(3)]);
    expect(await clocks(db)).toContainEqual({ field: 'title', hlc: h(3), base_hlc: h(1) });
    expect(await outbox(db)).toHaveLength(1);
    await db.close();
  });

  it('une valeur identique n’ajoute rien ; une écriture pendant la publication reçoit un nouveau numéro (INSERT OR REPLACE)', async () => {
    const db = await freshDb();
    await insertTask(db, 't1', h(1));
    const before = await db.select<{ seq: number }>('SELECT seq FROM sync_outbox');
    await db.execute("UPDATE task SET title = 'Facture', hlc = ? WHERE id = 't1'", [h(2)]);
    expect(await outbox(db)).toEqual([{ table_name: 'task', row_id: 't1', field: '*' }]);
    await db.execute("UPDATE task SET title = 'X', hlc = ? WHERE id = 't1'", [h(3)]);
    await db.execute("UPDATE task SET title = 'Y', hlc = ? WHERE id = 't1'", [h(4)]);
    const after = await db.select<{ seq: number; field: string }>('SELECT seq, field FROM sync_outbox ORDER BY seq');
    expect(after.map((r) => r.field)).toEqual(['*', 'title']);
    expect(after[1]?.seq).toBeGreaterThan(before[0]?.seq ?? 0);
    await db.close();
  });

  it('colonne locale ⇒ jamais dans sync_outbox (task.discarded, routine.paused, calendar_account.token_ref / username)', async () => {
    const db = await freshDb();
    await insertTask(db, 't1', h(1));
    await db.execute(
      `INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r1', ?, 'Lire', 'daily', '2026-10-01', ?, ?, ?, ?)`,
      [PRO, AT, AT, DEV, h(1)],
    );
    await db.execute(`INSERT INTO calendar_account (id, provider, label, created_at, updated_at, device_id, hlc) VALUES ('c1', 'icloud', '', ?, ?, ?, ?)`, [AT, AT, DEV, h(1)]);
    await db.execute('DELETE FROM sync_outbox');
    await db.execute("UPDATE task SET discarded = 1, hlc = ? WHERE id = 't1'", [h(2)]);
    await db.execute("UPDATE routine SET paused = 1, hlc = ? WHERE id = 'r1'", [h(2)]);
    await db.execute("UPDATE calendar_account SET token_ref = 'vault:x', username = 'ali@example.com', hlc = ? WHERE id = 'c1'", [h(2)]);
    expect(await outbox(db)).toEqual([]);
    // Le hlc de la ligne a bougé : le repli « * » garde l'ancien, aucun champ publié ne paraît plus récent.
    expect(await db.select("SELECT table_name, field, hlc FROM sync_field_clock WHERE field = '*' ORDER BY table_name")).toEqual([
      { table_name: 'calendar_account', field: '*', hlc: h(1) },
      { table_name: 'routine', field: '*', hlc: h(1) },
      { table_name: 'task', field: '*', hlc: h(1) },
    ]);
    await db.close();
  });

  it('réglages : seules les clés partagées entrent dans la file', async () => {
    const db = await freshDb();
    const set = (key: string, value: string) =>
      db.execute(
        'INSERT INTO settings (key, value, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc',
        [key, value, AT, DEV, h(5)],
      );
    await set('device.id', JSON.stringify(DEV));
    await set('ui.theme', '"dark"');
    await set('general.locale', '"en"');
    expect(await outbox(db)).toEqual([{ table_name: 'settings', row_id: 'general.locale', field: '*' }]);
    // Mise à jour par UPSERT (SettingsRepository.set) : les déclencheurs n'héritent pas d'un conflit « OR » ; une seule entrée.
    await db.execute('DELETE FROM sync_outbox');
    await set('general.locale', '"fr"');
    await set('general.locale', '"en"');
    expect(await outbox(db)).toEqual([{ table_name: 'settings', row_id: 'general.locale', field: 'value' }]);
    await db.close();
  });

  it('sync_guard : aucun déclencheur ne s’exécute tant qu’elle contient une ligne', async () => {
    const db = await freshDb();
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
      await tx.execute('INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)', ['t2', PRO, 'Garde', AT, AT, DEV, h(1)]);
      await tx.execute("UPDATE task SET title = 'G', hlc = ? WHERE id = 't2'", [h(2)]);
      await tx.execute('DELETE FROM sync_guard');
    });
    expect(await outbox(db)).toEqual([]);
    expect(await clocks(db)).toEqual([]);
    await db.close();
  });
});
