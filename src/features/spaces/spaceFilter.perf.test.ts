import { describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { buildManyTasks } from '../../db/seed/sampleData';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { createHlcClock } from '../../domain/hlc';
import { addDays } from '../../domain/localDate';
import { buildTodayList } from '../../domain/todayList';
import { buildWeek } from '../../domain/week';
import { asEntityId, asLocalDate, type DeviceId, type SpaceFilter } from '../../domain/types';
import { createAppContainer } from '../app/container';
import { selectTodayTasks, todayStore } from '../today/todayStore';
import { selectWeekTasks, weekStore } from '../week/weekStore';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000fc');
const DAY = asLocalDate('2026-10-05');

/**
 * ES-03 critère 7 : un changement de filtre Pro / Perso / Tout reste visible en moins de 100 ms avec 5 000 tâches en base. Le
 * filtrage est fait en requête (`spaceFilterClause`), pas dans le composant. Mesure avec le driver SQLite Wasm de dev, plus lent que
 * le SQLite natif de production.
 */
describe('Filtre d’espace : performance avec 5 000 tâches (ES-03)', () => {
  it('Aujourd’hui et la Semaine se rechargent en moins de 100 ms à chaque changement de filtre', async () => {
    const db = await openTestDb(DEVICE);
    try {
      // 5 000 tâches sur 100 jours autour de la semaine affichée : ≈ 50 par jour, ≈ 350 dans la semaine.
      const spread = buildManyTasks(DAY, 5000).map((task, i) => ({ ...task, date: addDays(addDays(DAY, -50), i % 100), spaceId: Math.floor(i / 100) % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID }));
      await db.data.repos.tasks.createMany(spread);
      const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      const today = todayStore.get(container);
      const week = weekStore.get(container);
      await today.getState().load(DAY, 'all');
      await week.getState().load(DAY, 'all');

      for (const filter of [SPACE_PRO_ID, SPACE_PERSO_ID, 'all'] as SpaceFilter[]) {
        const start = performance.now();
        await today.getState().load(DAY, filter);
        const tasks = selectTodayTasks(today.getState().taskIds, container.taskEntities.getSnapshot(), { date: DAY, filter });
        const list = buildTodayList({ date: DAY, filter, tasks });
        const todayElapsed = performance.now() - start;
        expect(list.rows.length).toBeGreaterThan(0);
        expect(list.rows.every((row) => row.kind !== 'task' || filter === 'all' || row.task.spaceId === filter)).toBe(true);
        expect(todayElapsed, `Aujourd’hui, filtre ${filter}`).toBeLessThan(100);

        const weekStart = DAY;
        const startWeek = performance.now();
        await week.getState().load(weekStart, filter);
        const weekTasks = selectWeekTasks(container.taskEntities.getSnapshot(), weekStart, filter);
        buildWeek({ weekStart, filter, tasks: weekTasks, extras: week.getState().extras });
        const weekElapsed = performance.now() - startWeek;
        // eslint-disable-next-line no-console -- mesure relevée à la main pour le rapport de performance (sortie de `npm run test:perf`)
        console.info(`[perf ES-03] 5 000 tâches, filtre ${filter} : Aujourd'hui ${todayElapsed.toFixed(1)} ms, Semaine ${weekElapsed.toFixed(1)} ms`);
        expect(weekElapsed, `Semaine, filtre ${filter}`).toBeLessThan(100);
      }
    } finally {
      await db.close();
    }
  }, 60_000);
});
