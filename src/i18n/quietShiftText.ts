import type { QuietShift, RoutineQuietSummary } from '../domain/quietShift';
import { weekdayOf } from '../domain/localDate';
import type { LocalDate, Weekday } from '../domain/types';
import { formatTime } from './format';
import { weekdayName } from './formatRoutine';
import { getLocale } from './index';

/**
 * N-FIX-04 : textes de l'avertissement de plage silencieuse (formulaires) et de la ligne de l'écran Routines. Formulation unique d'Ali :
 * « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 », une phrase, une cause. Catalogue chargé avec les formulaires et
 * l'écran Routines, jamais dans le bundle de départ.
 */
const fr = {
  shiftedDay: 'Rappel décalé au {day} {time} — {cause}',
  shiftedSameDay: 'Rappel décalé à {time} — {cause}',
  causeAfter: 'aucun rappel {space} après {from}',
  causeBefore: 'aucun rappel {space} avant {to}',
  causeWeekend: 'aucun rappel {space} le week-end',
  causeDays: 'aucun rappel {space} le {days}',
  allAt: 'Rappels décalés à {time}',
  all: 'Rappels décalés',
  partialTo: 'Rappels {of} décalés au {day} {time}',
  partialAt: 'Rappels {of} décalés à {time}',
  partial: 'Rappels {of} décalés',
  ofWeekend: 'du week-end',
  ofEveryDay: 'de tous les jours',
  ofDay: 'du {day}',
  and: ' et ',
  comma: ', ',
} as const;
const en: Record<keyof typeof fr, string> = {
  shiftedDay: 'Reminder moved to {day} {time} — {cause}',
  shiftedSameDay: 'Reminder moved to {time} — {cause}',
  causeAfter: 'no {space} reminders after {from}',
  causeBefore: 'no {space} reminders before {to}',
  causeWeekend: 'no {space} reminders on weekends',
  causeDays: 'no {space} reminders on {days}',
  allAt: 'Reminders moved to {time}',
  all: 'Reminders moved',
  partialTo: 'Reminders {of} moved to {day} {time}',
  partialAt: 'Reminders {of} moved to {time}',
  partial: 'Reminders {of} moved',
  ofWeekend: 'on weekends',
  ofEveryDay: 'every day',
  ofDay: 'on {day}',
  and: ' and ',
  comma: ', ',
};

type Key = keyof typeof fr;
const catalogue = (): typeof fr | typeof en => (getLocale() === 'en' ? en : fr);

function fill(key: Key, params: Readonly<Record<string, string>>): string {
  return catalogue()[key].replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '');
}

/** Nom long du jour, en minuscules dans les deux langues sauf l'anglais qui garde sa majuscule. */
const dayName = (weekday: Weekday): string => (getLocale() === 'en' ? weekdayName(weekday, 'long') : weekdayName(weekday, 'long').toLowerCase());

function joinDays(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(catalogue().comma)}${catalogue().and}${parts[parts.length - 1] ?? ''}`;
}

function causeText(shift: QuietShift, spaceName: string): string {
  const { cause } = shift;
  switch (cause.kind) {
    case 'after':
      return fill('causeAfter', { space: spaceName, from: formatTime(cause.from) });
    case 'before':
      return fill('causeBefore', { space: spaceName, to: formatTime(cause.to) });
    case 'weekend':
      return fill('causeWeekend', { space: spaceName });
    case 'all-day':
      return fill('causeDays', { space: spaceName, days: joinDays(cause.weekdays.map(dayName)) });
  }
}

/** Ligne d'un formulaire pour un rappel décalé : « Rappel décalé au lundi 08:00 — aucun rappel Pro après 19:00 ». */
export function quietShiftFormText(shift: QuietShift, spaceName: string): string {
  const time = formatTime(shift.effective.slice(11, 16));
  const cause = causeText(shift, spaceName);
  if (shift.effective.slice(0, 10) === shift.fireAt.slice(0, 10)) return fill('shiftedSameDay', { time, cause });
  return fill('shiftedDay', { day: dayName(weekdayOf(shift.effective.slice(0, 10) as LocalDate)), time, cause });
}

/** Ligne de l'écran Routines ; null quand rien n'est décalé. */
export function routineQuietLineText(summary: RoutineQuietSummary): string | null {
  if (summary.state === 'none') return null;
  if (summary.state === 'all') return summary.time === null ? fill('all', {}) : fill('allAt', { time: formatTime(summary.time) });
  const of =
    summary.weekdays.length === 7
      ? fill('ofEveryDay', {})
      : summary.weekdays.length === 2 && summary.weekdays.includes(6) && summary.weekdays.includes(7)
        ? fill('ofWeekend', {})
        : joinDays(summary.weekdays.map((weekday) => fill('ofDay', { day: dayName(weekday) })));
  const { weekday, time } = summary.target;
  if (time !== null && weekday !== null) return fill('partialTo', { of, day: dayName(weekday), time: formatTime(time) });
  if (time !== null) return fill('partialAt', { of, time: formatTime(time) });
  return fill('partial', { of });
}
