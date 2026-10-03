import type { QuietHours } from '../../domain/model';
import { describeQuietHours, type QuietSummaryPart } from '../../domain/quietHours';
import type { Weekday } from '../../domain/types';
import { t } from '../../i18n';
import { weekdayName } from '../../i18n/formatRoutine';

const days = (weekdays: readonly Weekday[]): string => weekdays.map((day) => weekdayName(day, 'short')).join(', ');

function partText(part: QuietSummaryPart): string {
  switch (part.kind) {
    case 'every-day':
      return t('spaces.quietEveryDay', { from: part.from, to: part.to });
    case 'weekend-all-day':
      return t('spaces.quietWeekend');
    case 'all-day':
      return t('spaces.quietAllDay', { days: days(part.weekdays) });
    case 'range':
      return t('spaces.quietRange', { days: days(part.weekdays), from: part.from, to: part.to });
  }
}

/** Résumé d'une ligne « Silence Pro » (Reglages.html : « 19:00 – 08:00, week-end ») ; « Aucune » sans plage (ES-07 critère 2). */
export function formatQuietSummary(ranges: readonly QuietHours[]): string {
  const parts = describeQuietHours(ranges);
  return parts.length === 0 ? t('spaces.quietNone') : parts.map(partText).join(t('spaces.quietSeparator'));
}
