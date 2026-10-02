import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nowLocalTime, todayLocal } from '../../domain/clock';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000011');

/**
 * T-11 critères 1, 7 et 8 : tâches en heure locale flottante. On change le fuseau du
 * processus (TZ) entre l'écriture et la lecture : date et heure ne bougent pas, tandis que
 * « aujourd'hui » suit le fuseau courant de l'appareil.
 */
describe('heures flottantes (T-11)', () => {
  const initialTz = process.env['TZ'];
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-09-23T08:00:00.000Z');
  });
  afterEach(async () => {
    if (initialTz === undefined) delete process.env['TZ'];
    else process.env['TZ'] = initialTz;
    await db.close();
  });

  const useCases = () =>
    createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() });

  it('une tâche à 10:00 créée à Paris affiche toujours 10:00, même date, à Tunis (critère 1)', async () => {
    process.env['TZ'] = 'Europe/Paris';
    const created = await useCases().create({
      title: 'Point',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-09-23'),
      time: asLocalTime('10:00'),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (const tz of ['Africa/Tunis', 'Pacific/Auckland', 'America/Los_Angeles']) {
      process.env['TZ'] = tz;
      const read = await db.data.repos.tasks.getById(created.value.id);
      expect(read?.date).toBe('2026-09-23');
      expect(read?.time).toBe('10:00');
    }
  });

  it('02:30 le jour du passage à l’heure d’été reste 02:30 (critère 7)', async () => {
    process.env['TZ'] = 'Europe/Paris';
    const created = await useCases().create({
      title: 'Nuit courte',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-03-29'),
      time: asLocalTime('02:30'),
    });
    expect(created.ok && created.value.time).toBe('02:30');
    const read = created.ok ? await db.data.repos.tasks.getById(created.value.id) : null;
    expect(read?.time).toBe('02:30');
    expect(read?.date).toBe('2026-03-29');
  });

  it('« aujourd’hui » et l’heure courante suivent le fuseau de l’appareil (critère 8)', () => {
    db.clock.set('2026-09-23T22:30:00Z');
    process.env['TZ'] = 'Europe/Paris';
    expect(todayLocal(db.clock)).toBe('2026-09-24');
    expect(nowLocalTime(db.clock)).toBe('00:30');
    process.env['TZ'] = 'America/New_York';
    expect(todayLocal(db.clock)).toBe('2026-09-23');
    expect(nowLocalTime(db.clock)).toBe('18:30');
  });
});
