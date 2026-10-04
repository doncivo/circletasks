import { describe, expect, it } from 'vitest';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { asEntityId, type DeviceId, type LocalDate, type ProjectId } from '../../domain/types';
import { loadMonthReport } from './monthReportLoader';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000a04ff');
const MISSION = asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000e1');

/**
 * H-01 critère 13 et ES-08 critère 5 : avec 3 ans de données (5 000 tâches, 150 routines-jours, 1 000 sessions), le calcul complet du
 * mois puis son recalcul sous chaque filtre (Pro, projet) restent sous 300 ms. Seuil indicatif avec le driver Wasm de développement
 * (plus lent que sqlx) ; il repère une lecture de toutes les tâches ou un index manquant.
 */
describe('Rapport du mois sur 3 ans de données', () => {
  it('calcul complet puis recalcul par filtre en moins de 300 ms chacun', async () => {
    const db = await openTestDb(DEVICE);
    try {
      await db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Mission client', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [MISSION, SPACE_PRO_ID]);
      await db.driver.transaction(async (tx) => {
        for (let i = 0; i < 5000; i += 1) {
          await tx.execute(
            "INSERT INTO task (id, space_id, project_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, 'T', ?, ?, 1, 'z', 'z', 'd', 'h')",
            [
              `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
              i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID,
              i % 4 === 0 ? MISSION : null,
              new Date(Date.UTC(2023, 9, 4) + (i % 1100) * 86_400_000).toISOString().slice(0, 10),
              i % 3 === 0 ? 'todo' : 'done',
            ],
          );
        }
        for (let i = 0; i < 1000; i += 1) {
          const start = new Date(Date.UTC(2023, 9, 4, 8) + i * 26 * 3_600_000).toISOString();
          await tx.execute(
            "INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES (?, NULL, ?, 25, ?, ?, 0, 'z', 'z', 'd', 'h')",
            [`40000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SPACE_PRO_ID, start, new Date(Date.parse(start) + 25 * 60_000).toISOString()],
          );
        }
      });
      const base = { month: { year: 2026, month: 3 }, today: '2026-10-04' as LocalDate, firstWeekday: 'monday' as const };
      const timings: number[] = [];
      for (const filter of [{ space: 'all' as const, project: null }, { space: SPACE_PRO_ID, project: null }, { space: SPACE_PRO_ID, project: MISSION }]) {
        const start = performance.now();
        const report = await loadMonthReport(db.data, { ...base, filter });
        timings.push(performance.now() - start);
        expect(report.weeks.length).toBeGreaterThan(0);
      }
      for (const elapsed of timings) expect(elapsed).toBeLessThan(300);
    } finally {
      await db.close();
    }
  }, 60_000);
});
