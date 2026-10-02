import { describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, asLocalDate, type DeviceId } from '../../domain/types';
import { buildWeek, addWeeks } from '../../domain/week';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { buildManyTasks } from '../../db/seed/sampleData';
import { createAppContainer } from '../app/container';
import { selectWeekTasks, weekStore } from './weekStore';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000fd');
const WEEK = asLocalDate('2026-09-28');

/**
 * S-01 critère 10 et S-03 critère 6 : affichage de la Semaine (chargement des sept jours, sélection et assemblage) en moins de
 * 300 ms avec 5 000 tâches en base, réparties sur 100 jours autour de la semaine affichée (≈ 350 tâches dans la semaine), puis à
 * chaque changement de semaine. Mesure avec le driver SQLite Wasm de dev, plus lent que le SQLite natif de production.
 */
describe('Semaine : performance avec 5 000 tâches (S-01, S-03)', () => {
  it('charge et assemble la semaine en moins de 300 ms, puis la suivante', async () => {
    const db = await openTestDb(DEVICE);
    try {
      const spread = buildManyTasks(WEEK, 5000).map((task, i) => ({ ...task, date: addDays(addDays(WEEK, -50), i % 100) }));
      await db.data.repos.tasks.createMany(spread);
      const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      const store = weekStore.get(container);

      const display = async (weekStart: typeof WEEK) => {
        const start = performance.now();
        await store.getState().load(weekStart, 'all');
        const tasks = selectWeekTasks(container.taskEntities.getSnapshot(), weekStart, 'all');
        const days = buildWeek({ weekStart, filter: 'all', tasks, extras: store.getState().extras });
        return { elapsed: performance.now() - start, days };
      };

      const first = await display(WEEK);
      expect(store.getState().status).toBe('ready');
      expect(first.days.reduce((total, day) => total + day.list.rows.length, 0)).toBeGreaterThan(300);
      expect(first.elapsed).toBeLessThan(300);

      const next = await display(addWeeks(WEEK, 1));
      expect(next.days.reduce((total, day) => total + day.list.rows.length, 0)).toBeGreaterThan(300);
      expect(next.elapsed).toBeLessThan(300);
    } finally {
      await db.close();
    }
  }, 60_000);
});
