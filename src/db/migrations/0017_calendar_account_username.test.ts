import { describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migrations } from './index';

const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HLC = `000000000000001-0000-${DEV}`;
const AT = '2026-10-01T08:00:00.000Z';

describe('migration 0017 : calendar_account.username (Y-02 critère 10, audit M6)', () => {
  it('identifiant Apple déplacé dans username, label vidé, comptes Google inchangés, aucune entrée dans sync_outbox', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 16));
    const insert = `INSERT INTO calendar_account (id, provider, label, token_ref, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await db.execute(insert, ['a1', 'icloud', 'ali@icloud.com', 'vault:a1', AT, AT, DEV, HLC]);
    await db.execute(insert, ['a2', 'google', 'ali@gmail.com', 'vault:a2', AT, AT, DEV, HLC]);
    await db.execute('DELETE FROM sync_outbox');
    await migrate(db, migrations);
    expect(await db.select('SELECT id, label, username, token_ref FROM calendar_account ORDER BY id')).toEqual([
      { id: 'a1', label: '', username: 'ali@icloud.com', token_ref: 'vault:a1' },
      { id: 'a2', label: 'ali@gmail.com', username: '', token_ref: 'vault:a2' },
    ]);
    expect(await db.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(await db.select('SELECT * FROM sync_field_clock')).toEqual([]);
    expect(await db.select('SELECT * FROM sync_guard')).toEqual([]);
    await db.close();
  });
});
