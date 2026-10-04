import { describe, expect, it } from 'vitest';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { ALL_ITEMS } from '../../domain/itemFilter';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { buildHistoryCsv, buildHistoryJson } from './exportHistory';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000a03ff');

/**
 * H-03 critère 8 : 3 ans d'historique (5 000 tâches), l'export CSV ou JSON prend moins de 2 s (lecture par blocs de 500). Seuil de la
 * fiche appliqué tel quel avec le driver Wasm de développement, plus lent que sqlx.
 */
describe('Export de l’historique : 5 000 tâches', () => {
  it('CSV et JSON en moins de 2 s chacun', async () => {
    const db = await openTestDb(DEVICE);
    try {
      await db.driver.transaction(async (tx) => {
        for (let i = 0; i < 5000; i += 1) {
          await tx.execute(
            "INSERT INTO task (id, space_id, title, note, date, time, status, done_at, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, '09:30', 'done', ?, 1, 'z', 'z', 'd', 'h')",
            [
              `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
              i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID,
              `Tâche numéro ${String(i)}`,
              'Une note de quelques mots\navec un retour à la ligne ; et un point-virgule',
              new Date(Date.UTC(2023, 9, 4) + (i % 1000) * 86_400_000).toISOString().slice(0, 10),
              '2024-01-02T12:00:00.000Z',
            ],
          );
        }
      });
      const params = { filter: ALL_ITEMS, period: 'all' as const, month: { year: 2026, month: 9 }, exportedAt: '2026-10-04T10:00:00.000Z' as IsoDateTime, spaceName: null, projectName: null };
      let start = performance.now();
      const csv = await buildHistoryCsv(db.data, params);
      const csvMs = performance.now() - start;
      start = performance.now();
      const json = await buildHistoryJson(db.data, params);
      const jsonMs = performance.now() - start;
      expect(new TextDecoder().decode(csv).split('\r\n').length).toBeGreaterThan(5000);
      expect((JSON.parse(new TextDecoder().decode(json)) as { tasks: unknown[] }).tasks).toHaveLength(5000);
      expect(csvMs).toBeLessThan(2000);
      expect(jsonMs).toBeLessThan(2000);
    } finally {
      await db.close();
    }
  }, 60_000);
});
