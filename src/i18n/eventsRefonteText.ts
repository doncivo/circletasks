import { getLocale } from './index';

/** Textes propres à l'écran Événements iPhone (UI-REFONTE-07, Evenements-v2.html) : chargés avec l'écran, hors du bundle de départ. */
const fr = {
  hideHolidays: 'Masquer les fériés',
  showHolidays: 'Afficher les fériés',
  calendarView: 'Vue calendrier',
  addEvent: 'Événement',
} as const;
const en: Record<keyof typeof fr, string> = {
  hideHolidays: 'Hide holidays',
  showHolidays: 'Show holidays',
  calendarView: 'Calendar view',
  addEvent: 'Event',
};

export function tEventsRefonte(key: keyof typeof fr): string {
  return (getLocale() === 'en' ? en : fr)[key];
}
