import { describe, expect, it } from 'vitest';
import { reintegrateUnknownFields } from '../repositories';
import { SHARED_SETTING_KEYS, SYNC_TABLES, publishedColumns } from '../../domain/sync/syncTables';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { CAPTURE_TABLES_V15 } from './0015_sync_tables';
import { CAPTURE_TABLES_V18, SHARED_SETTING_KEYS_V18, migration0018AppleReminders } from './0018_apple_reminders';
import { migrations } from './index';

const PRO = '00000000-0000-4000-8000-000000000001';
const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const h = (ms: number): string => `${String(ms).padStart(15, '0')}-0000-${DEV}`;
const AT = '2026-10-01T08:00:00.000Z';
const T1 = '11111111-1111-4111-8111-111111111111';

async function dbAt(version: number): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  await migrate(db, migrations.slice(0, version));
  return db;
}

async function insertTask(db: SqlDriver, id: string, hlc: string, title = 'Facture'): Promise<void> {
  await db.execute('INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, PRO, title, AT, AT, DEV, hlc]);
}

const outbox = (db: SqlDriver) => db.select<{ table_name: string; row_id: string; field: string }>('SELECT table_name, row_id, field FROM sync_outbox ORDER BY seq');
const triggers = (db: SqlDriver) => db.select<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");

describe('migration 0018 : Rappels Apple (K-05 critère 1, ADR 0008 §10.2)', () => {
  it('numéro suivant, sans trou ; rejouable sans effet ; version publiée = dernière migration', async () => {
    expect(migration0018AppleReminders.version).toBe(18);
    expect(migrations.at(-1)?.version).toBe(18);
    const db = await dbAt(18);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    await db.close();
  });

  it('la copie figée (version 18) est égale au catalogue de synchro courant : tables, colonnes, ordre et clés de réglage', () => {
    expect(CAPTURE_TABLES_V18.map(([t, key, cols]) => [t, key, [...cols]])).toEqual(SYNC_TABLES.map((t) => [t.name, t.key, [...publishedColumns(t)]]));
    expect([...SHARED_SETTING_KEYS_V18]).toEqual([...SHARED_SETTING_KEYS]);
    // V18 = V15 + les deux colonnes de `task` et les quatre clés des Rappels Apple, rien d'autre.
    const v15Task = CAPTURE_TABLES_V15.find(([t]) => t === 'task')?.[2] ?? [];
    const v18Task = CAPTURE_TABLES_V18.find(([t]) => t === 'task')?.[2] ?? [];
    expect(v18Task.filter((column) => !v15Task.includes(column))).toEqual(['apple_list_id', 'apple_recurring']);
    expect(CAPTURE_TABLES_V18.filter(([t]) => t !== 'task')).toEqual(CAPTURE_TABLES_V15.filter(([t]) => t !== 'task'));
    expect(SHARED_SETTING_KEYS_V18.filter((key) => key.startsWith('appleReminders.'))).toEqual(['appleReminders.create', 'appleReminders.lastPassAt', 'appleReminders.lists', 'appleReminders.pending']);
    // `appleReminders.status` est locale : jamais publiée.
    expect(SHARED_SETTING_KEYS_V18).not.toContain('appleReminders.status');
  });

  it('base de version 17 peuplée : migrée sans perte, colonnes nulles, rien de nouveau dans la file ni dans les horloges', async () => {
    const db = await dbAt(17);
    await insertTask(db, 't1', h(1));
    await insertTask(db, 't2', h(2), 'Appeler');
    await db.execute("UPDATE task SET title = 'Facture 2', hlc = ? WHERE id = 't1'", [h(3)]);
    await db.execute(
      `INSERT INTO calendar_account (id, provider, label, created_at, updated_at, device_id, hlc) VALUES ('c1', 'google', 'a@b.c', ?, ?, ?, ?)`,
      [AT, AT, DEV, h(2)],
    );
    const before = { outbox: await outbox(db), clocks: await db.select('SELECT * FROM sync_field_clock ORDER BY table_name, row_id, field') };
    expect(before.outbox.length).toBeGreaterThan(0);
    const report = await migrate(db, migrations);
    expect(report.applied).toEqual([18]);
    expect(await db.select('SELECT id, title, source, external_id, apple_list_id, apple_recurring FROM task ORDER BY id')).toEqual([
      { id: 't1', title: 'Facture 2', source: 'local', external_id: null, apple_list_id: null, apple_recurring: 0 },
      { id: 't2', title: 'Appeler', source: 'local', external_id: null, apple_list_id: null, apple_recurring: 0 },
    ]);
    expect(await outbox(db)).toEqual(before.outbox);
    expect(await db.select('SELECT * FROM sync_field_clock ORDER BY table_name, row_id, field')).toEqual(before.clocks);
    expect(await db.select('SELECT * FROM sync_guard')).toEqual([]);
    expect(await db.select('SELECT * FROM apple_reminder_link')).toEqual([]);
    await db.close();
  });

  it('les déclencheurs de task et de settings sont recréés ; les autres ne changent pas', async () => {
    const db17 = await dbAt(17);
    const old = await triggers(db17);
    await db17.close();
    const db = await dbAt(18);
    const now = await triggers(db);
    expect(now.map((t) => t.name)).toEqual(old.map((t) => t.name));
    const changed = now.filter((t, i) => t.sql !== old[i]?.sql).map((t) => t.name);
    // Les quatre sont recréés ; seul le corps de `sync_task_ai` est resté identique (il ne cite aucune colonne).
    expect(changed).toEqual(['sync_settings_ai', 'sync_settings_au', 'sync_task_au']);
    await db.close();
  });

  it('une modification de apple_list_id ou apple_recurring produit une entrée ; l’insertion une entrée « * » ; la valeur identique rien', async () => {
    const db = await dbAt(18);
    await insertTask(db, 't1', h(1));
    expect(await outbox(db)).toEqual([{ table_name: 'task', row_id: 't1', field: '*' }]);
    await db.execute('DELETE FROM sync_outbox');
    await db.execute("UPDATE task SET source = 'apple_reminders', external_id = 'E1', apple_list_id = 'L1', apple_recurring = 1, hlc = ? WHERE id = 't1'", [h(2)]);
    expect((await outbox(db)).map((row) => row.field)).toEqual(['source', 'external_id', 'apple_list_id', 'apple_recurring']);
    const clock = await db.select<{ field: string; hlc: string }>("SELECT field, hlc FROM sync_field_clock WHERE field IN ('apple_list_id', 'apple_recurring') ORDER BY field");
    expect(clock).toEqual([
      { field: 'apple_list_id', hlc: h(2) },
      { field: 'apple_recurring', hlc: h(2) },
    ]);
    await db.execute('DELETE FROM sync_outbox');
    await db.execute("UPDATE task SET apple_list_id = 'L1', apple_recurring = 1, hlc = ? WHERE id = 't1'", [h(3)]);
    expect(await outbox(db)).toEqual([]);
    await db.close();
  });

  it('réglages : les quatre clés partagées entrent dans la file, le statut local jamais', async () => {
    const db = await dbAt(18);
    const set = (key: string, value: string) =>
      db.execute('INSERT INTO settings (key, value, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, hlc = excluded.hlc', [key, value, AT, DEV, h(5)]);
    await set('appleReminders.lists', '{"lists":[]}');
    await set('appleReminders.create', '{"bySpace":[]}');
    await set('appleReminders.lastPassAt', '"2026-10-01T08:00:00.000Z"');
    await set('appleReminders.pending', 'null');
    await set('appleReminders.status', '{"failure":null}');
    expect((await outbox(db)).map((row) => row.row_id)).toEqual(['appleReminders.lists', 'appleReminders.create', 'appleReminders.lastPassAt', 'appleReminders.pending']);
    await db.close();
  });

  it('apple_reminder_link est locale : aucune écriture ne produit d’entrée ni d’horloge, l’identifiant du rappel est unique', async () => {
    const db = await dbAt(18);
    await db.execute("INSERT INTO apple_reminder_link (task_id, reminder_id, list_id, state) VALUES ('t1', 'R1', 'L1', 'linked')");
    await db.execute("UPDATE apple_reminder_link SET synced = '{}', apple_modified = ? WHERE task_id = 't1'", [AT]);
    expect(await outbox(db)).toEqual([]);
    expect(await db.select('SELECT * FROM sync_field_clock')).toEqual([]);
    await expect(db.execute("INSERT INTO apple_reminder_link (task_id, reminder_id, list_id, state) VALUES ('t2', 'R1', 'L1', 'linked')")).rejects.toThrow();
    await expect(db.execute("INSERT INTO apple_reminder_link (task_id, reminder_id, list_id, state) VALUES ('t3', NULL, 'L1', 'inconnu')")).rejects.toThrow();
    // Deux créations en cours (identifiant encore nul) coexistent.
    await db.execute("INSERT INTO apple_reminder_link (task_id, reminder_id, list_id, state) VALUES ('t4', NULL, 'L1', 'creating'), ('t5', NULL, 'L1', 'creating')");
    await expect(db.execute("INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc, apple_recurring) VALUES ('x', ?, 'x', ?, ?, ?, ?, 2)", [PRO, AT, AT, DEV, h(1)])).rejects.toThrow();
    await db.close();
  });

  it('K-05 critère 2 : un appareil en version 17 range les champs inconnus dans sync_unknown ; après sa mise à jour la valeur est retrouvée', async () => {
    const db = await dbAt(18);
    await insertTask(db, T1, h(1));
    // Ce que garderait un appareil de version 17 qui reçoit une tâche liée : champs hors de son catalogue.
    await db.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES ('task', ?, 'apple_list_id', '\"L1\"', ?, NULL, 18)", [T1, h(9)]);
    await db.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) VALUES ('task', ?, 'apple_recurring', '1', ?, NULL, 18)", [T1, h(9)]);
    const report = await reintegrateUnknownFields(db, { now: AT as never });
    expect(report).toBeDefined();
    expect(await db.select('SELECT apple_list_id, apple_recurring FROM task WHERE id = ?', [T1])).toEqual([{ apple_list_id: 'L1', apple_recurring: 1 }]);
    expect(await db.select('SELECT * FROM sync_unknown')).toEqual([]);
    await db.close();
  });
});
