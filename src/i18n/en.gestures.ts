import type { Messages } from './types';

/** Row gesture texts on iPhone (A-07) in English (optional language, PRD section 8): same shape as fr.gestures.ts, checked by typing. */
export const gesturesEn: Messages['gestures'] = {
  actionsGroup: 'Actions: {title}',
  complete: 'Complete',
  reopen: 'Reopen',
  postpone: 'Postpone',
  someday: 'Someday',
  delete: 'Delete',
  today: 'Today',
  tomorrow: 'Tomorrow',
  pickDate: 'Date…',
  actionLabel: '{action}: {title}',
  planTodayLabel: 'Schedule today: {title}',
  planTomorrowLabel: 'Schedule tomorrow: {title}',
  pickDateLabel: 'Pick a date for: {title}',
};
