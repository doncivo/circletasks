import type { RepositoryFactory } from '../dataAccess';
import { createCalendarAccountRepository, createEventRepository, createExternalEventRepository } from './agendaRepository';
import { createChecklistItemRepository, createChecklistRepository } from './checklistRepository';
import { createFocusSessionRepository } from './focusSessionRepository';
import { createGoalRepository } from './goalRepository';
import { createHolidayRepository } from './holidayRepository';
import { createReminderRepository } from './reminderRepository';
import { createSearchRepository } from './searchRepository';
import { createRoutineLogRepository, createRoutineRepository } from './routineRepository';
import { createSettingsRepository, createSyncMetaRepository } from './settingsRepository';
import { createProjectRepository, createSpaceRepository } from './spaceRepository';
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
  checklists: createChecklistRepository(executor, stamper),
  checklistItems: createChecklistItemRepository(executor, stamper),
  externalEvents: createExternalEventRepository(executor),
  calendarAccounts: createCalendarAccountRepository(executor, stamper),
  syncMeta: createSyncMetaRepository(executor),
});
