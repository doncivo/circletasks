import { describe, expect, it } from 'vitest';
import { buildMatchExpression, searchTokens } from '../../../domain/search';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-0000000000a2');
const STAMP = ['2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'] as const;
const WORDS = ['facture', 'notaire', 'courses', 'réunion', 'passeport', 'sport', 'budget', 'voiture', 'dentiste', 'loyer', 'vacances', 'contrat'];

/**
 * RC-01 critère 7 (PRD section 7) : une recherche répond en moins de 200 ms avec 5 000 tâches (titre et note), 50 routines, 500
 * événements, des checklists et leurs items. Mesure avec le driver SQLite Wasm de dev (plus lent que le SQLite natif de production),
 * requête complète : index FTS5, jointures, filtre d'espace, conversion des lignes. Les mots les plus fréquents sont cherchés.
 */
describe('SearchRepository (SQL) : performance (RC-01)', () => {
  it('répond en moins de 200 ms avec 5 000 tâches, 50 routines et 500 événements', async () => {
    const db = await openTestDb(DEVICE);
    try {
      await db.driver.transaction(async (tx) => {
        for (let i = 0; i < 5000; i += 1) {
          const w = (k: number): string => WORDS[(i + k) % WORDS.length] as string;
          await tx.execute(
            `INSERT INTO task (id, space_id, title, note, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?)`,
            [`t${String(i)}`, i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID, `Tâche ${String(i)} ${w(0)} ${w(3)}`, `Penser à la ${w(5)} puis au ${w(7)} numéro ${String(i)}`, '2026-10-05', i, ...STAMP],
          );
        }
        for (let i = 0; i < 50; i += 1) {
          await tx.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, 'daily', '2026-09-01', ?, ?, ?, ?)`, [`r${String(i)}`, SPACE_PRO_ID, `Routine ${WORDS[i % WORDS.length] as string} ${String(i)}`, ...STAMP]);
        }
        for (let i = 0; i < 500; i += 1) {
          await tx.execute(`INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, '2026-10-10', '2026-10-10', ?, ?, ?, ?)`, [`e${String(i)}`, SPACE_PERSO_ID, `Événement ${WORDS[i % WORDS.length] as string} ${String(i)}`, ...STAMP]);
        }
        for (let i = 0; i < 100; i += 1) {
          await tx.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)`, [`c${String(i)}`, SPACE_PRO_ID, `Liste ${WORDS[i % WORDS.length] as string}`, ...STAMP]);
          for (let j = 0; j < 8; j += 1) {
            await tx.execute(`INSERT INTO checklist_item (id, checklist_id, text, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [`i${String(i)}-${String(j)}`, `c${String(i)}`, `Item ${WORDS[(i + j) % WORDS.length] as string}`, j, ...STAMP]);
          }
        }
      });

      const worst: number[] = [];
      for (const query of ['facture', 'fact', 'notaire', 'réunion budget', 'tâche 42', 'pass']) {
        for (const space of ['all', SPACE_PRO_ID] as const) {
          const start = performance.now();
          const hits = await db.data.repos.search.query({ match: buildMatchExpression(searchTokens(query)), space, limit: 101 });
          worst.push(performance.now() - start);
          expect(hits.length, query).toBeGreaterThan(0);
        }
      }
      expect(Math.max(...worst), `temps de chaque requête (ms) : ${worst.map((ms) => ms.toFixed(1)).join(" / ")}`).toBeLessThan(200);
    } finally {
      await db.close();
    }
  }, 60_000);
});
