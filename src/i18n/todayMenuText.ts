import { getLocale } from './index';

/** Catalogue du menu « Plus d’options » d'Aujourd'hui (UI-REFONTE-02) : chargé avec le menu, hors du départ. */
const fr = {
  goals: 'Objectif de la semaine',
  report: 'Rapport mensuel',
  compact: 'Vue compacte',
  edit: 'Mode édition',
} as const;
const en: Record<keyof typeof fr, string> = {
  goals: 'Goal of the week', report: 'Monthly report', compact: 'Compact view', edit: 'Edit mode',
};

export function tTodayMenu(key: keyof typeof fr): string {
  return (getLocale() === 'en' ? en : fr)[key];
}
