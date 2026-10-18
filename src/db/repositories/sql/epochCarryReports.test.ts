import { describe, expect, it } from 'vitest';
import { createManualClock } from '../../../domain/clock';
import { createHlcClock, createWriteStamper } from '../../../domain/hlc';
import { EMPTY_CARRY_REPORT_BODY, EPOCH_CARRY_REPORT_KEEP, type EpochCarryReportBody, type EpochCarryReportHead } from '../../../domain/sync/epochCarryReport';
import type { DeviceId, Hlc, IsoDateTime } from '../../../domain/types';
import { openSqliteWasmDriver } from '../../drivers/sqliteWasm';
import { migrations } from '../../migrations';
import { migrate } from '../../migrator';
import { createSqlRepositories } from './index';

/** Y-TECH-05 (critères 10, 13, 15) : dépôt des comptes rendus, chargé à la demande par `Repositories.carryReports()`. */

const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const AT = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const head = (epoch: string): EpochCarryReportHead => ({ epoch, cause: 'restore', reporter: DEV, opener: DEV, mode: 'replace', createdAt: AT });

async function open() {
  const db = await openSqliteWasmDriver();
  await migrate(db, migrations);
  const clock = createManualClock(AT);
  const hlc = createHlcClock({ clock, deviceId: DEV });
  const repos = createSqlRepositories(db, createWriteStamper(clock, hlc));
  return { db, reports: await repos.carryReports() };
}

describe('EpochCarryReportRepository', () => {
  it('création, enregistrement et relecture à l’identique ; auteurs triés', async () => {
    const { db, reports } = await open();
    const id = await reports.create(head('2-x'));
    expect(await reports.get(id)).toEqual({ id, ...head('2-x'), ...EMPTY_CARRY_REPORT_BODY, banner: false, acknowledgedAt: null, damaged: false });
    const body: EpochCarryReportBody = {
      authors: [
        { device: 'c' as DeviceId, fields: 3, rows: 1, tombs: 0, late: 0 },
        { device: 'b' as DeviceId, fields: 2, rows: 1, tombs: 1, late: 0 },
      ],
      restored: [{ table: 'task', rowId: 'r', label: 'À jeter', by: 'c' as DeviceId, deletedAt: AT, deletedBy: 'a' as DeviceId }],
      recreated: [{ table: 'task', rowId: 't', label: 'Test Pc', by: 'c' as DeviceId, deletedAt: null, deletedBy: null }],
      parentReplaced: [{ table: 'task', rowId: 'p', column: 'project_id', parentId: 'P', space: 'pro', label: 'Sous P', hlc: 'h' as Hlc, kind: 'reattached', cause: 'parent-replaced' }],
      overflow: 4,
      overflowBy: { restored: 1, recreated: 3, parentReplaced: 0 },
    };
    await reports.save(id, body, true);
    expect(await reports.get(id)).toEqual({ id, ...head('2-x'), ...body, authors: [body.authors[1], body.authors[0]], banner: true, acknowledgedAt: null, damaged: false });
    expect(await reports.get(id + 1)).toBeNull();
    await db.close();
  });

  it('colonne JSON illisible : lue vide, compte rendu marqué « damaged », jamais un échec', async () => {
    const { db, reports } = await open();
    const id = await reports.create(head('e'));
    await db.execute("UPDATE epoch_carry_report SET restored = '{pas du json' WHERE id = ?", [id]);
    expect(await reports.get(id)).toMatchObject({ restored: [], damaged: true });
    await db.close();
  });

  it('liste du plus récent au plus ancien ; non acquittés ; « J’ai vu » une seule fois', async () => {
    const { db, reports } = await open();
    const first = await reports.create(head('e1'));
    const second = await reports.create(head('e2'));
    expect((await reports.list(20)).map((r) => r.id)).toEqual([second, first]);
    expect((await reports.unacknowledged()).map((r) => r.id)).toEqual([second, first]);
    expect(await reports.acknowledge(second, AT)).toBe(true);
    expect(await reports.acknowledge(second, '2026-10-06T08:00:00.000Z' as IsoDateTime)).toBe(false);
    expect((await reports.get(second))?.acknowledgedAt).toBe(AT);
    expect((await reports.unacknowledged()).map((r) => r.id)).toEqual([first]);
    expect(await reports.acknowledge(999, AT)).toBe(false);
    await db.close();
  });

  it('critère 13 : au-delà de 20, les plus anciens acquittés sont supprimés ; un non acquitté jamais, même au-delà de 20', async () => {
    const { db, reports } = await open();
    const ids: number[] = [];
    for (let i = 0; i < 25; i += 1) ids.push(await reports.create(head(`e${String(i)}`)));
    // Acquittés : tous sauf le 1er et le 3e (les plus anciens).
    for (const id of ids) if (id !== ids[0] && id !== ids[2]) await reports.acknowledge(id, AT);
    expect(await reports.prune(EPOCH_CARRY_REPORT_KEEP)).toBe(3);
    const kept = (await reports.list(100)).map((r) => r.id);
    expect(kept).toEqual([...ids.slice(5).reverse(), ids[2], ids[0]]);
    expect(await reports.prune(EPOCH_CARRY_REPORT_KEEP)).toBe(0);
    // Aucun acquitté : rien n'est supprimé, même à 30.
    const second = await open();
    for (let i = 0; i < 30; i += 1) await second.reports.create(head(`f${String(i)}`));
    expect(await second.reports.prune(EPOCH_CARRY_REPORT_KEEP)).toBe(0);
    expect(await second.reports.list(100)).toHaveLength(30);
    await db.close();
    await second.db.close();
  });
});
