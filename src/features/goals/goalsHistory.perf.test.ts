import { describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { createHlcClock } from '../../domain/hlc';
import { addDays } from '../../domain/localDate';
import { asEntityId, asLocalDate, type DeviceId, type SpaceFilter } from '../../domain/types';
import { createAppContainer } from '../app/container';
import { goalsStore } from './goalsStore';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000fd');
const STAMP = '2026-01-01T00:00:00.000Z';

/**
 * OB-06 critère 7 : l'historique s'affiche en moins de 300 ms avec 3 ans d'objectifs, chargé par pages de 20 semaines. Mesure avec le
 * driver SQLite Wasm de dev, plus lent que le SQLite natif de production.
 */
describe('Historique des objectifs : performance avec 3 ans d’objectifs (OB-06)', () => {
  it('première page et page suivante en moins de 300 ms, pour chaque filtre d’espace', async () => {
    const db = await openTestDb(DEVICE);
    try {
      const today = asLocalDate('2026-10-05');
      // 156 semaines, 2 objectifs par semaine (Pro et Perso), le Pro reconduit d'une semaine à l'autre.
      await db.driver.transaction(async (tx) => {
        for (let week = 1; week <= 156; week += 1) {
          const weekStart = addDays(today, -7 * week);
          for (const [index, space] of [SPACE_PRO_ID, SPACE_PERSO_ID].entries()) {
            const n = week * 2 + index;
            const parent = index === 0 && week > 1 ? `c0000000-0000-4000-8000-${String((week - 1) * 2).padStart(12, '0')}` : null;
            await tx.execute(
              `INSERT INTO goal (id, space_id, week_start, title, pinned, status, carried_from_id, created_at, updated_at, device_id, hlc)
               VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'e2e', ?)`,
              [`c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, space, weekStart, `Objectif ${n}`, week % 3 === 0 ? 'achieved' : 'closed', parent, STAMP, STAMP, `0000000000${String(n).padStart(5, '0')}-0000-e2e`],
            );
          }
        }
      });
      const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      const store = goalsStore.get(container);
      for (const filter of ['all', SPACE_PRO_ID, SPACE_PERSO_ID] as SpaceFilter[]) {
        const start = performance.now();
        await store.getState().loadHistory(today, filter);
        const elapsed = performance.now() - start;
        expect(store.getState().history.length).toBeGreaterThanOrEqual(20);
        expect(store.getState().historyHasMore).toBe(true);
        expect(elapsed, `première page, filtre ${filter}`).toBeLessThan(300);
        const startMore = performance.now();
        await store.getState().loadMoreHistory();
        const moreMs = performance.now() - startMore;
        // eslint-disable-next-line no-console -- mesure relevée à la main pour le rapport de performance (sortie de `npm run test:perf`)
        console.info(`[perf OB-06] historique 156 semaines, filtre ${filter} : première page ${elapsed.toFixed(1)} ms, page suivante ${moreMs.toFixed(1)} ms`);
        expect(moreMs, `page suivante, filtre ${filter}`).toBeLessThan(300);
      }
      // Toute la profondeur : 156 semaines, jamais plus de 20 par page.
      expect(store.getState().history.length).toBeGreaterThan(20);
    } finally {
      await db.close();
    }
  });
});
