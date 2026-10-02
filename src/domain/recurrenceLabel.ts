import type { RecurrenceFields } from './model';
import { parseLocalDate } from './localDate';
import type { LocalDate } from './types';

/**
 * Résumé lisible d'une règle (T-09 critère 6) sous forme de références i18n paramétrées :
 * le domaine ne dépend pas de src/i18n, la résolution est faite par `formatMessageRef`
 * (src/i18n/formatRecurrence.ts). Clés sous `recurrence.*`.
 */
export interface MessageRef {
  readonly key: string;
  readonly params?: Readonly<Record<string, MessageParam>>;
}
export type MessageParam = string | number | MessageRef | readonly MessageParam[];

export type RecurrenceLabelStyle = 'detail' | 'short';

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const ORDINAL_KEYS = ['first', 'second', 'third', 'fourth', 'fifth'] as const;
const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const FREQ_NAMES = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' } as const;

const weekdayRef = (kind: 'weekdayShort' | 'weekdayLong', d: number): MessageRef => ({
  key: `recurrence.${kind}.${WEEKDAY_KEYS[d - 1]}`,
});
const monthRef = (month: number): MessageRef => ({ key: `recurrence.month.${MONTH_KEYS[month - 1]}` });
const dayParam = (day: number): MessageParam => (day === 1 ? { key: 'recurrence.dayFirst' } : day);

function shortLabel(rule: RecurrenceFields): MessageRef {
  const base = `recurrence.short${FREQ_NAMES[rule.freq]}`;
  return rule.interval > 1 ? { key: `${base}N`, params: { interval: rule.interval } } : { key: base };
}

function detailLabel(rule: RecurrenceFields, anchor: LocalDate | null): MessageRef {
  const pick = (key: string, params: Record<string, MessageParam> = {}): MessageRef =>
    rule.interval > 1 ? { key: `${key}N`, params: { ...params, interval: rule.interval } } : { key, params };
  switch (rule.freq) {
    case 'daily':
      return pick('recurrence.daily');
    case 'weekly': {
      const days = [...rule.weekdays].sort((a, b) => a - b).map((d) => weekdayRef('weekdayShort', d));
      return pick('recurrence.weekly', { days });
    }
    case 'monthly': {
      const nth = rule.nthWeekday;
      if (nth === null) return pick('recurrence.monthlyDay', { day: dayParam(rule.monthDay ?? 1) });
      const weekday = weekdayRef('weekdayLong', nth.weekday);
      return nth.nth === -1
        ? pick('recurrence.monthlyLast', { weekday })
        : pick('recurrence.monthlyNth', { nth: { key: `recurrence.ordinal.${ORDINAL_KEYS[nth.nth - 1]}` }, weekday });
    }
    case 'yearly': {
      const parsed = anchor === null ? { month: 1, day: 1 } : parseLocalDate(anchor);
      return pick('recurrence.yearly', { day: dayParam(rule.monthDay ?? parsed.day), month: monthRef(parsed.month) });
    }
  }
}

/**
 * « Mensuelle, le 23 », « Toutes les semaines : lun., jeu. », « Tous les 3 jours » (style
 * `detail`, avec fin « , jusqu’au 31 déc. 2026 » ou « , 6 fois ») ; « mensuelle », « hebdo »,
 * « tous les 3 j » (style `short`, sans fin). `anchor` : date de la tâche (mois d'une annuelle).
 */
export function recurrenceLabel(
  rule: RecurrenceFields,
  anchor: LocalDate | null,
  style: RecurrenceLabelStyle = 'detail',
): MessageRef {
  if (style === 'short') return shortLabel(rule);
  const summary = detailLabel(rule, anchor);
  if (rule.until !== null) {
    const { year, month, day } = parseLocalDate(rule.until);
    return { key: 'recurrence.endUntil', params: { summary, day, month: monthRef(month), year } };
  }
  if (rule.count !== null) return { key: 'recurrence.endCount', params: { summary, count: rule.count } };
  return summary;
}
