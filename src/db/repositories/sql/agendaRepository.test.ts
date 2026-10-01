import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, asLocalDate, type DeviceId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000007');

/**
 * `EventRepository` et `ChecklistRepository` n'exposent que des lectures à
 * l'ordre 1 (ADR 0004) : les lignes de test sont insérées directement en SQL,
 * comme le fera la migration d'écriture de checklists-events (ordre 2).
 */
async function insertEvent(
  db: TestDb,
  args: { id: string; spaceId: string; start: string; end: string; repeat?: string },
): Promise<void> {
  await db.driver.execute(
    `INSERT INTO event (id, space_id, title, start_date, start_time, end_date, end_time, all_day, kind, repeat, important, icon, birth_year, created_at, updated_at, deleted_at, device_id, hlc)
     VALUES (?, ?, 'Événement test', ?, NULL, ?, NULL, 1, 'event', ?, 0, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ?, '000000000000000-0000-fixture')`,
    [args.id, args.spaceId, args.start, args.end, args.repeat ?? 'once', DEVICE],
  );
}

async function insertChecklist(db: TestDb, args: { id: string; spaceId: string; date: string | null }): Promise<string> {
  await db.driver.execute(
    `INSERT INTO checklist (id, space_id, title, date, is_template, created_at, updated_at, deleted_at, device_id, hlc)
     VALUES (?, ?, 'Valise', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ?, '000000000000000-0000-fixture')`,
    [args.id, args.spaceId, args.date, DEVICE],
  );
  return args.id;
}

async function insertChecklistItem(db: TestDb, args: { id: string; checklistId: string; checked: boolean }): Promise<void> {
  await db.driver.execute(
    `INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, deleted_at, device_id, hlc)
     VALUES (?, ?, 'Item', ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, ?, '000000000000000-0000-fixture')`,
    [args.id, args.checklistId, args.checked ? 1 : 0, DEVICE],
  );
}

describe('EventRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('retrouve les événements ponctuels qui chevauchent la plage (A-01, S-01)', async () => {
    await insertEvent(db, { id: 'e0000000-0000-4000-8000-000000000001', spaceId: SPACE_PRO_ID, start: '2026-10-05', end: '2026-10-05' });
    await insertEvent(db, { id: 'e0000000-0000-4000-8000-000000000002', spaceId: SPACE_PRO_ID, start: '2026-11-01', end: '2026-11-01' });
    const range = { from: asLocalDate('2026-10-01'), to: asLocalDate('2026-10-07') };
    const hits = await db.data.repos.events.listCandidatesForRange(range, 'all');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.startDate).toBe('2026-10-05');
  });

  it('inclut toujours les événements répétés mensuels ou annuels', async () => {
    await insertEvent(db, {
      id: 'e0000000-0000-4000-8000-000000000003',
      spaceId: SPACE_PERSO_ID,
      start: '2020-03-15',
      end: '2020-03-15',
      repeat: 'yearly',
    });
    const range = { from: asLocalDate('2026-10-01'), to: asLocalDate('2026-10-07') };
    expect(await db.data.repos.events.listCandidatesForRange(range, 'all')).toHaveLength(1);
    expect(await db.data.repos.events.listCandidatesForRange(range, SPACE_PRO_ID)).toEqual([]);
  });
});

describe('ChecklistRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('calcule la progression « coché / total » pour un jour (C-02)', async () => {
    const checklistId = await insertChecklist(db, { id: 'f0000000-0000-4000-8000-000000000001', spaceId: SPACE_PRO_ID, date: '2026-10-05' });
    await insertChecklistItem(db, { id: 'f0000000-0000-4000-8000-000000000011', checklistId, checked: true });
    await insertChecklistItem(db, { id: 'f0000000-0000-4000-8000-000000000012', checklistId, checked: true });
    await insertChecklistItem(db, { id: 'f0000000-0000-4000-8000-000000000013', checklistId, checked: false });

    const summaries = await db.data.repos.checklists.listSummariesForDay(asLocalDate('2026-10-05'), 'all');
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ checked: 2, total: 3 });
  });

  it('listSummariesForRange couvre plusieurs jours', async () => {
    await insertChecklist(db, { id: 'f0000000-0000-4000-8000-000000000002', spaceId: SPACE_PRO_ID, date: '2026-10-05' });
    await insertChecklist(db, { id: 'f0000000-0000-4000-8000-000000000003', spaceId: SPACE_PRO_ID, date: '2026-10-06' });
    const summaries = await db.data.repos.checklists.listSummariesForRange(
      { from: asLocalDate('2026-10-05'), to: asLocalDate('2026-10-06') },
      'all',
    );
    expect(summaries).toHaveLength(2);
  });
});
