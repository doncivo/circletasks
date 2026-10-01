import { describe, expect, it } from 'vitest';
import { asEntityId, asLocalDate, type DeviceId } from '../../../domain/types';
import { buildManyTasks } from '../../seed/sampleData';
import { openTestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000ff');
const DAY = asLocalDate('2026-10-05');

/**
 * Test de performance indicatif (CLAUDE.md, PRD section 8) : `listForDay` doit
 * rester rapide avec 5 000 tâches, grâce à l'index `idx_task_date_space`.
 *
 * Seuil large (2 s), pas 50 ms : le driver de dev (`@sqlite.org/sqlite-wasm`,
 * ADR 0002) ne reflète pas les performances natives de `tauri-plugin-sql`
 * (sqlx). Mesuré indépendamment de tout index ou requête SQL, la seule
 * conversion ligne → objet JS à travers la frontière Wasm coûte ~100-150 ms
 * pour 5 000 lignes de 23 colonnes en isolation, et jusqu'à ~500-600 ms quand
 * Vitest exécute ce fichier dans un worker partagé avec d'autres tests ouvrant
 * aussi le driver Wasm (tas WebAssembly qui grossit). Le test reste utile pour
 * repérer une régression grossière (index manquant forçant un tri complet,
 * N+1, oubli du filtre par date) ; le seuil ne garantit pas les 50 ms visés en
 * production, où le SQLite natif de sqlx n'a pas ce coût de frontière.
 */
describe('TaskRepository (SQL) — performance', () => {
  it('listForDay reste rapide avec 5000 tâches', async () => {
    const db = await openTestDb(DEVICE);
    try {
      await db.data.repos.tasks.createMany(buildManyTasks(DAY, 5000));

      const start = performance.now();
      const result = await db.data.repos.tasks.listForDay(DAY, 'all');
      const elapsed = performance.now() - start;

      expect(result).toHaveLength(5000);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await db.close();
    }
  }, 20_000);
});
