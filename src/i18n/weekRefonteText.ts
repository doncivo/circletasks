import { getLocale } from './index';

/**
 * Textes et formats propres à la Semaine iPhone (UI-REFONTE-03, Semaine-v2.html) : chargés avec l'écran Semaine, hors du bundle de
 * départ (critère 11). Les clés partagées avec le PC (« Semaine précédente », « Cette semaine »…) restent dans `fr.ts`.
 */
const fr = {
  caption: 'semaine {number}',
  captionYear: 'semaine {number} · {year}',
  remaining: '{count} tâches restantes',
  remainingOne: '1 tâche restante',
  remainingNone: 'aucune restante',
  done: '{count} faites',
  doneOne: '1 faite',
  doneNone: 'aucune faite',
  late: '{count} en retard',
  summaryEmpty: 'Rien de prévu cette semaine',
  dayEmpty: 'Rien de prévu',
  lateMark: 'en retard',
  selectDay: 'Choisir {day} pour l’ajout',
  addTo: 'Ajouter à {day}',
  addLabel: 'Nouvelle tâche',
} as const;
const en: Record<keyof typeof fr, string> = {
  caption: 'week {number}',
  captionYear: 'week {number} · {year}',
  remaining: '{count} tasks left',
  remainingOne: '1 task left',
  remainingNone: 'none left',
  done: '{count} done',
  doneOne: '1 done',
  doneNone: 'none done',
  late: '{count} late',
  summaryEmpty: 'Nothing planned this week',
  dayEmpty: 'Nothing planned',
  lateMark: 'late',
  selectDay: 'Choose {day} for adding',
  addTo: 'Add to {day}',
  addLabel: 'New task',
};

export type WeekRefonteKey = keyof typeof fr;

export function tWeekRefonte(key: WeekRefonteKey, params: Record<string, string | number> = {}): string {
  let text: string = (getLocale() === 'en' ? en : fr)[key];
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
  return text;
}

/** « 8 tâches restantes · 6 faites » ; « 1 tâche restante · aucune faite » ; le segment « en retard » est rendu à part par l'écran. */
export function formatWeekCounts(remaining: number, done: number): string {
  const left = remaining === 0 ? tWeekRefonte('remainingNone') : remaining === 1 ? tWeekRefonte('remainingOne') : tWeekRefonte('remaining', { count: remaining });
  const finished = done === 0 ? tWeekRefonte('doneNone') : done === 1 ? tWeekRefonte('doneOne') : tWeekRefonte('done', { count: done });
  return `${left} · ${finished}`;
}

const intlLocale = (): string => (getLocale() === 'fr' ? 'fr-FR' : 'en-US');
const utcDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00Z`);

/** Jour court en minuscules (« lun. ») et numéro, pour la colonne de gauche des sections iPhone. */
export function formatWeekDayLower(isoDate: string): { weekday: string; day: string } {
  const date = utcDate(isoDate);
  const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', timeZone: 'UTC' }).format(date);
  return { weekday: weekday.toLocaleLowerCase(intlLocale()), day: String(date.getUTCDate()) };
}

/** « jeudi 24 » : jour long en minuscules et numéro, pour la rangée d'ajout (« Ajouter à jeudi 24 ») et la sélection d'un jour. */
export function formatAddDayLabel(isoDate: string): string {
  const date = utcDate(isoDate);
  const weekday = new Intl.DateTimeFormat(intlLocale(), { weekday: 'long', timeZone: 'UTC' }).format(date);
  return `${weekday.toLocaleLowerCase(intlLocale())} ${String(date.getUTCDate())}`;
}
