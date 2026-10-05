import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_MAX_ROWS } from '../../domain/csvImport';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { createImportUseCases } from './importUseCases';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f8');

/**
 * P-07 critère 12 (mesure, `npm run test:perf`) : 5 000 lignes analysées, écrites par lots dans une transaction (avec rappels pour les lignes
 * horodatées) puis annulées d'un coup, sur SQLite Wasm en mémoire. Les chiffres du 2026-10-05 sont notés dans docs/stories/P-07.md.
 */
describe('Import de 5 000 lignes (P-07 critère 12)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T10:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
  });

  afterEach(async () => {
    await db.close();
  });

  it('analyse, écriture par lots et annulation d’un coup', async () => {
    const useCases = createImportUseCases(container);
    const rows = Array.from({ length: IMPORT_MAX_ROWS }, (_, i) => `Tâche ${String(i)};2026-10-${String(3 + (i % 20)).padStart(2, '0')};${i % 2 === 0 ? '09:30' : ''};${i % 2 === 0 ? 'Pro' : 'Perso'};;note ${String(i)}`);
    const text = `titre;date;heure;espace;projet;note\n${rows.join('\n')}`;

    const t0 = performance.now();
    const analyzed = await useCases.analyze('gros.csv', text, 'today');
    const analyzeMs = performance.now() - t0;
    if (!analyzed.ok) throw new Error(analyzed.error);
    expect(analyzed.preview.validation.valid).toHaveLength(IMPORT_MAX_ROWS);

    const t1 = performance.now();
    await useCases.run(analyzed.preview);
    const writeMs = performance.now() - t1;
    const count = async (): Promise<number> => (await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL'))[0]?.n ?? 0;
    expect(await count()).toBe(IMPORT_MAX_ROWS);
    const reminders = (await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM reminder WHERE deleted_at IS NULL'))[0]?.n ?? 0;
    expect(reminders).toBe(IMPORT_MAX_ROWS / 2);

    const t2 = performance.now();
    expect(await container.undo.undoLast()).toMatchObject({ status: 'undone' });
    const undoMs = performance.now() - t2;
    expect(await count()).toBe(0);
    expect((await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM reminder WHERE deleted_at IS NULL'))[0]?.n).toBe(0);

    // eslint-disable-next-line no-console -- mesure relevée à la main pour la fiche de la story
    console.info(`[P-07 perf] 5000 lignes : analyse ${analyzeMs.toFixed(0)} ms, écriture ${writeMs.toFixed(0)} ms, annulation ${undoMs.toFixed(0)} ms`);
    expect(analyzeMs).toBeLessThan(5000);
    expect(writeMs).toBeLessThan(30_000);
    expect(undoMs).toBeLessThan(15_000);
  }, 120_000);
});
