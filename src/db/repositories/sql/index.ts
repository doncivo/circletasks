import type { RepositoryFactory } from '../dataAccess';
import { createAppleReminderLinkRepository } from './appleReminderLinks';
import { createCalendarAccountRepository, createEventRepository, createExternalEventRepository } from './agendaRepository';
import { createChecklistItemRepository, createChecklistRepository } from './checklistRepository';
import { createFocusSessionRepository } from './focusSessionRepository';
import { createGoalRepository } from './goalRepository';
import { createHolidayRepository } from './holidayRepository';
import { createReminderRepository } from './reminderRepository';
import { createSearchRepository } from './searchRepository';
import { createStatsRepository } from './statsRepository';
import { createRoutineLogRepository, createRoutineRepository } from './routineRepository';
import { createSettingsRepository, createSyncMetaRepository } from './settingsRepository';
import { createProjectRepository, createSpaceRepository } from './spaceRepository';
// Y-04 (début)
import { createSyncConflictRepository } from './syncConflicts';
// Y-04 (fin)
import { createSyncRepository } from './syncRepository';
// Y-07 (début)
export { reintegrateUnknownFields } from './syncUnknown';
// Y-07 (fin)
import { createRecurrenceRepository, createTaskRepository } from './taskRepository';

/**
 * Fabrique SQL des repositories (data-model, ADR 0004) : une implémentation par
 * agrégat, branchée sur l'exécuteur et le tampon d'écriture reçus (driver ou
 * transaction). Fabrique par défaut de `bootstrapApp`.
 */
export const createSqlRepositories: RepositoryFactory = (executor, stamper) => ({
  spaces: createSpaceRepository(executor, stamper),
  projects: createProjectRepository(executor, stamper),
  tasks: createTaskRepository(executor, stamper),
  recurrences: createRecurrenceRepository(executor, stamper),
  routines: createRoutineRepository(executor, stamper),
  routineLogs: createRoutineLogRepository(executor, stamper),
  reminders: createReminderRepository(executor, stamper),
  goals: createGoalRepository(executor, stamper),
  settings: createSettingsRepository(executor, stamper),
  events: createEventRepository(executor, stamper),
  holidays: createHolidayRepository(executor, stamper),
  focusSessions: createFocusSessionRepository(executor, stamper),
  search: createSearchRepository(executor),
  stats: createStatsRepository(executor),
  checklists: createChecklistRepository(executor, stamper),
  checklistItems: createChecklistItemRepository(executor, stamper),
  externalEvents: createExternalEventRepository(executor),
  calendarAccounts: createCalendarAccountRepository(executor, stamper),
  syncMeta: createSyncMetaRepository(executor),
  appleLinks: createAppleReminderLinkRepository(executor),
  // Y-04 (début)
  syncConflicts: createSyncConflictRepository(executor, stamper),
  // Y-04 (fin)
  sync: createSyncRepository(executor, stamper),
  // Y-07 (début)
  // Y-07 (fin)
});
