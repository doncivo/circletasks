import type { SqlDriver, SqlParams } from './driver';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from './seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent, type FixtureAccount, type FixtureExternalEvent } from './seed/externalEventFixtures';

/**
 * Prises de test des e2e Playwright (navigateur de développement uniquement) : la base y est en mémoire et vide à chaque
 * chargement, sans connecteur d'agenda avant M8 ni moyen d'y poser 5 000 tâches par l'interface. `window.__ctTest` n'existe
 * que si Vite sert l'app en développement avec le driver SQLite Wasm : jamais dans un build, jamais dans l'app Tauri.
 * Les features ne l'utilisent pas ; seuls les tests de bout en bout l'appellent.
 */
export interface DevTestHooks {
  /** Exécute une instruction SQL (insertion d'`external_event`, `calendar_account`). */
  execute(sql: string, params?: SqlParams): Promise<void>;
  /** S-05 : pose un compte d'agenda et ses agendas (jeu de test, aucun connecteur avant K-01). */
  seedCalendarAccount(account: FixtureAccount): Promise<void>;
  /** S-05 : pose un événement d'agenda externe (instants UTC). */
  seedExternalEvent(event: FixtureExternalEvent): Promise<void>;
  /**
   * Insère `count` tâches à faire, réparties sur `spanDays` jours consécutifs à partir de `firstDate` ('YYYY-MM-DD'),
   * titrées « Tâche 1 »… « Tâche N », en une transaction (mesure de performance : 5 000 tâches).
   */
  seedTasks(count: number, firstDate: string, spanDays: number): Promise<void>;
}

declare global {
  interface Window {
    __ctTest?: DevTestHooks;
  }
}

const STAMP = '2026-01-01T00:00:00.000Z';

function addDaysIso(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function installDevTestHooks(driver: SqlDriver): void {
  if (!import.meta.env.DEV || driver.kind !== 'sqlite-wasm' || typeof window === 'undefined') return;
  window.__ctTest = {
    async execute(sql, params) {
      await driver.execute(sql, params);
    },
    seedCalendarAccount: (account) => insertCalendarAccount(driver, account),
    seedExternalEvent: (event) => insertExternalEvent(driver, event),
    async seedTasks(count, firstDate, spanDays) {
      await driver.transaction(async (tx) => {
        for (let i = 0; i < count; i += 1) {
          const id = `20000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
          await tx.execute(
            `INSERT INTO task (id, space_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc)
             VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, 'e2e', ?)`,
            [id, i % 2 === 0 ? SPACE_PRO_ID : SPACE_PERSO_ID, `Tâche ${String(i + 1)}`, addDaysIso(firstDate, i % spanDays), i, STAMP, STAMP, `0000000000${String(i).padStart(5, '0')}-0000-e2e`],
          );
        }
      });
    },
  };
}
