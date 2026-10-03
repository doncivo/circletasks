import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRO_QUIET_HOURS } from '../../domain/quietHours';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SEED_HLC, SPACE_PERSO_ID, SPACE_PRO_ID } from '../seed/defaultSpaces';
import { migrations } from './index';
import { PRO_QUIET_HOURS_JSON } from './0007_pro_quiet_hours';

const quietOf = async (db: SqlDriver, id: string): Promise<string> => (await db.select<{ quiet_hours: string }>('SELECT quiet_hours FROM space WHERE id = ?', [id]))[0]?.quiet_hours ?? '';

describe('migration 0007 (ES-07) : plages silencieuses par défaut de Pro', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('le texte JSON figé de la migration est celui de DEFAULT_PRO_QUIET_HOURS', () => {
    expect(JSON.parse(PRO_QUIET_HOURS_JSON)).toEqual(DEFAULT_PRO_QUIET_HOURS);
    expect(PRO_QUIET_HOURS_JSON).toBe(JSON.stringify(DEFAULT_PRO_QUIET_HOURS));
  });

  it('base neuve : Pro a ses plages, Perso aucune (critère 1)', async () => {
    await migrate(db, migrations);
    expect(JSON.parse(await quietOf(db, SPACE_PRO_ID))).toEqual(DEFAULT_PRO_QUIET_HOURS);
    expect(await quietOf(db, SPACE_PERSO_ID)).toBe('[]');
  });

  it('base peuplée 0001 → 7 : les données existantes sont intactes, Pro reçoit ses plages sans changer de hlc, rejouable', async () => {
    await migrate(db, migrations.slice(0, 6));
    expect(await quietOf(db, SPACE_PRO_ID)).toBe('[]');
    await db.execute(
      `INSERT INTO task (id, space_id, title, date, created_at, updated_at, device_id, hlc) VALUES ('t1', ?, 'Facture', '2026-10-02', 'z', 'z', 'd', 'h')`,
      [SPACE_PRO_ID],
    );
    await db.execute(
      `INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r1', ?, 'Sport', 'daily', '2026-09-01', 'z', 'z', 'd', 'h')`,
      [SPACE_PERSO_ID],
    );
    expect((await migrate(db, migrations)).applied).toEqual([7]);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    expect(JSON.parse(await quietOf(db, SPACE_PRO_ID))).toEqual(DEFAULT_PRO_QUIET_HOURS);
    expect(await quietOf(db, SPACE_PERSO_ID)).toBe('[]');
    const pro = await db.select<{ hlc: string; updated_at: string }>('SELECT hlc, updated_at FROM space WHERE id = ?', [SPACE_PRO_ID]);
    expect(pro[0]?.hlc).toBe(SEED_HLC);
    expect(await db.select('SELECT title FROM task')).toEqual([{ title: 'Facture' }]);
    expect(await db.select('SELECT title FROM routine')).toEqual([{ title: 'Sport' }]);
  });

  it('des plages déjà réglées par l’utilisateur sont conservées', async () => {
    await migrate(db, migrations.slice(0, 6));
    const custom = JSON.stringify([{ weekdays: [1], from: '12:00', to: '13:00' }]);
    await db.execute('UPDATE space SET quiet_hours = ? WHERE id = ?', [custom, SPACE_PRO_ID]);
    await migrate(db, migrations);
    expect(await quietOf(db, SPACE_PRO_ID)).toBe(custom);
  });

  it('un Pro volontairement sans plage après la migration n’est pas rétabli par un nouveau lancement', async () => {
    await migrate(db, migrations);
    await db.execute("UPDATE space SET quiet_hours = '[]' WHERE id = ?", [SPACE_PRO_ID]);
    await migrate(db, migrations);
    expect(await quietOf(db, SPACE_PRO_ID)).toBe('[]');
  });
});
