import { describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migrations } from './index';

describe('migration 0004 (T-12) : colonne discarded', () => {
  it('ajoute discarded = 0 par défaut, rejouable sans effet', async () => {
    const db = await openSqliteWasmDriver();
    expect((await migrate(db, migrations)).applied).toEqual([1, 2, 3, 4]);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const cols = await db.select<{ name: string; dflt_value: string | null }>("SELECT name, dflt_value FROM pragma_table_info('task') WHERE name = 'discarded'", []);
    expect(cols).toEqual([{ name: 'discarded', dflt_value: '0' }]);
    await db.close();
  });
});
