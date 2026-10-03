import type { WriteStamper } from '../../domain/hlc';
import type { SqlDriver, SqlExecutor } from '../driver';
import type { CalendarAccountRepository, EventRepository, ExternalEventRepository } from './agendaRepository';
import type { ChecklistItemRepository, ChecklistRepository } from './checklistRepository';
import type { GoalRepository } from './goalRepository';
import type { ReminderRepository } from './reminderRepository';
import type { RoutineLogRepository, RoutineRepository } from './routineRepository';
import type { SettingsRepository, SyncMetaRepository } from './settingsRepository';
import type { ProjectRepository, SpaceRepository } from './spaceRepository';
import type { RecurrenceRepository, TaskRepository } from './taskRepository';

/** Ensemble des repositories liés à un même exécuteur (driver ou transaction). */
export interface Repositories {
  readonly spaces: SpaceRepository;
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly recurrences: RecurrenceRepository;
  readonly routines: RoutineRepository;
  readonly routineLogs: RoutineLogRepository;
  readonly reminders: ReminderRepository;
  readonly goals: GoalRepository;
  readonly settings: SettingsRepository;
  readonly events: EventRepository;
  readonly checklists: ChecklistRepository;
  readonly checklistItems: ChecklistItemRepository;
  readonly externalEvents: ExternalEventRepository;
  readonly calendarAccounts: CalendarAccountRepository;
  readonly syncMeta: SyncMetaRepository;
}

/**
 * Fabrique des repositories SQL (implémentation : data-model, `src/db/repositories/sql/`).
 * Appelée une fois pour le driver, puis une fois par transaction avec le `tx` reçu.
 */
export type RepositoryFactory = (executor: SqlExecutor, stamper: WriteStamper) => Repositories;

/**
 * Point d'entrée unique des features vers la base (via le conteneur, ADR 0004).
 * - `repos` : lectures et écritures simples ;
 * - `transaction(work)` : écritures multiples atomiques d'un cas d'usage. Dans `work`,
 *   utiliser uniquement les repositories reçus en paramètre : appeler `repos` du
 *   DataAccess depuis une transaction bloquerait la file (DbError
 *   'transaction-wait-timeout', ADR 0002).
 */
export interface DataAccess {
  readonly repos: Repositories;
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

export function createDataAccess(driver: SqlDriver, stamper: WriteStamper, factory: RepositoryFactory): DataAccess {
  return {
    repos: factory(driver, stamper),
    transaction: (work) => driver.transaction((tx) => work(factory(tx, stamper))),
  };
}

/** Méthode de contrat non encore implémentée (squelette d'architecture). */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

/**
 * Repositories de remplacement tant que data-model n'a pas livré `createSqlRepositories` :
 * tout appel de méthode lève `NotImplementedError` en nommant la méthode.
 * À ne plus utiliser dès que les implémentations SQL existent.
 */
export const createPendingRepositories: RepositoryFactory = () =>
  new Proxy({} as Repositories, {
    get: (_target, repoName) =>
      new Proxy(
        {},
        {
          get: (_repo, method) => () =>
            Promise.reject(new NotImplementedError(`${String(repoName)}.${String(method)} : à implémenter (data-model)`)),
        },
      ),
  });
