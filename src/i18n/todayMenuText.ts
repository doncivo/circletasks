import { getLocale } from './index';

/** Catalogue du menu « Plus d’options » d'Aujourd'hui (UI-REFONTE-02) : chargé avec le menu, hors du départ. */
const fr = {
  someday: 'Un jour',
  somedayCount: 'Un jour · {count}',
  goals: 'Objectif de la semaine',
  report: 'Rapport mensuel',
  compact: 'Vue compacte',
  edit: 'Mode édition',
} as const;
const en: Record<keyof typeof fr, string> = {
  someday: 'Someday', somedayCount: 'Someday · {count}', goals: 'Goal of the week', report: 'Monthly report', compact: 'Compact view', edit: 'Edit mode',
};

export function tTodayMenu(key: keyof typeof fr, params?: { count: number }): string {
  const text = (getLocale() === 'en' ? en : fr)[key];
  return params ? text.replace('{count}', String(params.count)) : text;
}
