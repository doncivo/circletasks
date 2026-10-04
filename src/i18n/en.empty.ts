import type { Messages } from './types';

/** Empty-state texts in English (optional language): same shape as fr.empty.ts, checked by typing. */
export const emptyEn: Messages['empty'] = {
  announcement: 'Empty screen: {title}',
  addTask: 'Add a task',
  openSomeday: 'Open “Someday” · {count} tasks',
  openSomedayOne: 'Open “Someday” · 1 task',
  weekTitle: 'Nothing planned this week.',
  weekTitleSpace: 'No {space} tasks this week.',
  createRoutine: 'Create a routine',
  addEvent: 'Add an event',
  createChecklist: 'Create a checklist',
  addSomeday: 'Add to “Someday”',
  goToToday: 'Go to Today',
  openRoutines: 'See routines',
};
