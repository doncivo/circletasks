import { getLocale } from './index';

/** Textes de la seconde colonne d'Aujourd'hui sur PC (UI-REFONTE-08, PC-Jour.html) : chargés avec le bloc, hors du bundle de départ. */
const fr = {
  tomorrow: 'Demain',
  thisWeek: 'Cette semaine',
  shortcuts: 'Raccourcis',
  nothing: 'Rien de prévu',
  hintNew: 'nouvelle tâche',
  hintSearch: 'rechercher',
  hintAll: 'tous les raccourcis',
  regionLabel: 'Ce qui arrive',
} as const;
const en: Record<keyof typeof fr, string> = {
  tomorrow: 'Tomorrow',
  thisWeek: 'This week',
  shortcuts: 'Shortcuts',
  nothing: 'Nothing planned',
  hintNew: 'new task',
  hintSearch: 'search',
  hintAll: 'all shortcuts',
  regionLabel: 'Coming up',
};

export function tTodaySide(key: keyof typeof fr): string {
  return (getLocale() === 'en' ? en : fr)[key];
}
