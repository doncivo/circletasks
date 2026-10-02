import { describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import { createHlcClock } from '../../domain/hlc';
import { buildTodayList } from '../../domain/todayList';
import { asEntityId, asLocalDate, type DeviceId } from '../../domain/types';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { buildManyTasks } from '../../db/seed/sampleData';
import { createAppContainer } from '../app/container';
import { selectTodayTasks, todayStore } from './todayStore';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000fe');
const DAY = asLocalDate('2026-10-05');

/**
 * A-01 critère 9 : premier affichage d'Aujourd'hui (chargement du jour + assemblage de la liste) en moins de
 * 300 ms avec 5 000 tâches en base, réparties sur 100 jours (≈ 50 par jour). Mesure avec le driver SQLite Wasm
 * de dev, plus lent que le SQLite natif de production (voir taskRepository.perf.test.ts).
 */
describe('Aujourd’hui : performance avec 5 000 tâches (A-01)', () => {
  it('charge et assemble la liste du jour en moins de 300 ms', async () => {
    const db = await openTestDb(DEVICE);
    try {
      const spread = buildManyTasks(DAY, 5000).map((task, i) => ({ ...task, date: addDays(DAY, i % 100) }));
      await db.data.repos.tasks.createMany(spread);
      const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      const store = todayStore.get(container);

      const start = performance.now();
      await store.getState().load(DAY, 'all');
      const state = store.getState();
      const tasks = selectTodayTasks(state.taskIds, container.taskEntities.getSnapshot(), { date: DAY, filter: 'all' });
      const list = buildTodayList({ date: DAY, filter: 'all', tasks });
      const elapsed = performance.now() - start;

      expect(state.status).toBe('ready');
      expect(list.rows).toHaveLength(50);
      expect(elapsed).toBeLessThan(300);
    } finally {
      await db.close();
    }
  }, 30_000);
});
