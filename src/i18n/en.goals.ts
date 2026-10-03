import type { Messages } from './types';

/** Weekly goal module texts in English (optional language, PRD section 8): same shape as fr.goals.ts, checked by typing. */
export const goalsEn: Messages['goals'] = {
  open: 'Goal of the week',
  title: 'Goal',
  back: 'Back',
  panelLabel: 'Goal of the week',
  panelCaption: 'GOAL',
  weekLine: 'Week {number} · {range}',
  titleLabel: 'Goal of the week',
  titleLabelN: 'Goal of the week ({number})',
  titlePlaceholder: 'My goal for the week',
  helpEmpty: 'Set what matters this week',
  addGoal: '+ Add a goal',
  iconButton: 'Goal icon',
  spaceLabel: 'Goal space',
  deleteGoal: 'Delete goal',
  deleteTitle: 'Delete the goal “{title}”?',
  deleteDescription: 'Its linked tasks stay, without a goal.',
  deleteConfirm: 'Delete',
  loadError: 'Unable to load goals.',
  saveError: 'Unable to save this goal.',
  titleTooLong: 'The title must not exceed 200 characters.',
  undo: {
    deleted: 'Goal “{title}” deleted',
  },
};
