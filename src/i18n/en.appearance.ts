import type { Messages } from './types';

/** Appearance and formats screen texts in English (optional language): same shape as fr.appearance.ts, checked by typing. */
export const appearanceEn: Messages['appearance'] = {
  row: 'Theme · week · time',
  summarySeparator: ' · ',
  title: 'Appearance and formats',
  back: 'Back to settings',
  sectionWeek: 'WEEK',
  firstDay: 'First day',
  firstDayLabel: 'First day of the week',
  monday: 'Monday',
  saturday: 'Saturday',
  sunday: 'Sunday',
  weekHint: 'Goals, the report and "every N weeks" routines stay on Monday-based weeks.',
  sectionLanguage: 'LANGUAGE',
  language: 'Language',
  languageValue: 'French',
  languageHint: 'Other languages are not planned',
  sectionTime: 'TIME',
  timeFormat: 'Format',
  timeFormatLabel: 'Time format',
  format24: '24 h',
  format12: '12 h',
  timeExample: 'Example: {time}',
  saveError: 'Unable to save this setting.',
};
