import { describe, expect, it } from 'vitest';
import { ALL_ITEMS } from '../../../domain/itemFilter';
import { asEntityId, type DeviceId, type LocalDate } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000a01ff');

/**
 * H-01 critère 13 : 3 ans de données (5 000 tâches, 1 000 objectifs et sessions), les agrégats du mois restent rapides. Seuil indicatif
 * (300 ms pour les quatre requêtes ; le driver Wasm de développement est plus lent que sqlx, voir taskRepository.perf.test.ts) : ce test
 * repère une régression grossière (index manquant, lecture de toutes les tâches).
 */
describe('StatsRepository (SQL) : agrégats sur 5 000 tâches', () => {
  it('semaines du mois, objectifs et plus ancienne donnée restent rapides', async () => {
    const db = await openTestDb(DEVICE);
    try {
      await db.driver.transaction(async (tx) => {
        const first = Date.UTC(2023, 9, 4);
        for (let i = 0; i < 5000; i += 1) {
          const date = new Date(first + (i % 1100) * 86_400_000).toISOString().slice(0, 10);
          await tx.execute(
            `INSERT INTO task (id, space_id, title, date, status, sort_order, someday, created_at, updated_at, device_id, hlc)
             VALUES (?, ?, 'T', ?, ?, 1, 0, 'z', 'z', 'd', 'h')`,
            [`20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID, date, i % 3 === 0 ? 'todo' : 'done'],
          );
        }
        for (let i = 0; i < 150; i += 1) {
          const week = new Date(first + i * 7 * 86_400_000).toISOString().slice(0, 10);
          await tx.execute(
            "INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, 'G', 'achieved', 'z', 'z', 'd', 'h')",
            [`50000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SPACE_PRO_ID, week],
          );
        }
      });
      const range = { from: '2026-03-01' as LocalDate, to: '2026-03-31' as LocalDate };
      const start = performance.now();
      const weeks = await db.data.repos.stats.taskCountsByWeek({ range, filter: ALL_ITEMS });
      const pro = await db.data.repos.stats.taskCountsByWeek({ range, filter: { space: SPACE_PRO_ID, project: null } });
      const goals = await db.data.repos.stats.goalCounts({ range, filter: ALL_ITEMS });
      const oldest = await db.data.repos.stats.oldestActivity();
      const elapsed = performance.now() - start;
      // eslint-disable-next-line no-console -- mesure relevée à la main pour le rapport de performance (sortie de `npm run test:perf`)
      console.info(`[perf H-01] StatsRepository, quatre requêtes sur 3 ans : ${elapsed.toFixed(1)} ms`);
      expect(weeks.length).toBeGreaterThan(0);
      expect(pro.length).toBeGreaterThan(0);
      expect(goals.total).toBeGreaterThanOrEqual(0);
      expect(oldest).toBe('2023-10-04');
      expect(elapsed).toBeLessThan(300);
    } finally {
      await db.close();
    }
  }, 60_000);
});
