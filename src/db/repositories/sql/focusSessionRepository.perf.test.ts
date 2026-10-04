import { describe, expect, it } from 'vitest';
import { daySpan, monthSpan } from '../../../domain/focusTotals';
import { ALL_ITEMS } from '../../../domain/itemFilter';
import { asEntityId, type DeviceId, type LocalDate } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000f03ff');

/**
 * F-03 critère 9 : 3 ans de sessions (2 000 lignes), totaux du jour / du mois / par tâche calculés par une requête agrégée.
 * Seuil indicatif (200 ms pour quatre requêtes ; le driver Wasm de développement n'a pas les performances de sqlx, voir taskRepository.perf.test.ts) : la
 * cible de production est de 50 ms par requête ; ce test repère une régression grossière (index manquant, calcul ligne à ligne en JavaScript).
 */
describe('FocusSessionRepository (SQL) : totaux sur 2 000 sessions', () => {
  it('le total du jour, du mois et le classement des tâches restent rapides', async () => {
    const db = await openTestDb(DEVICE);
    try {
      await db.driver.transaction(async (tx) => {
        const first = Date.UTC(2023, 9, 4, 8, 0, 0);
        for (let i = 0; i < 2000; i += 1) {
          const start = new Date(first + i * 13 * 60 * 60 * 1000);
          const end = new Date(start.getTime() + (20 + (i % 70)) * 60_000);
          await tx.execute(
            `INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, paused_at, created_at, updated_at, deleted_at, device_id, hlc)
             VALUES (?, ?, ?, 25, ?, ?, ?, NULL, 'z', 'z', NULL, 'd', 'h')`,
            [`40000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `20000000-0000-4000-8000-${String(i % 150).padStart(12, '0')}`, i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID, start.toISOString(), end.toISOString(), (i % 5) * 30],
          );
        }
      });
      const day = '2026-03-12' as LocalDate;
      const start = performance.now();
      const today = await db.data.repos.focusSessions.totals({ span: daySpan(day), filter: ALL_ITEMS });
      const month = await db.data.repos.focusSessions.totals({ span: monthSpan(day), filter: { space: SPACE_PRO_ID, project: null } });
      const top = await db.data.repos.focusSessions.totalsByTask({ span: monthSpan(day), filter: ALL_ITEMS }, 5);
      const all = await db.data.repos.focusSessions.totals({ span: { from: '2000-01-01T00:00:00.000Z' as never, to: '2100-01-01T00:00:00.000Z' as never }, filter: ALL_ITEMS });
      const elapsed = performance.now() - start;
      expect(all.sessions).toBe(2000);
      expect(today.sessions).toBeGreaterThanOrEqual(0);
      expect(month.sessions).toBeGreaterThan(0);
      expect(top.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(200); // mesuré : environ 13 ms pour les quatre requêtes
    } finally {
      await db.close();
    }
  }, 30_000);
});
