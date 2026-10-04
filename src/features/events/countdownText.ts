import { getLocale, t } from '../../i18n';

export interface CountdownTag {
  /** « J-12 » ou « Aujourd'hui ». */
  readonly label: string;
  /** Lecture à voix haute : « dans 12 jours » ; absent le jour même (« Aujourd'hui » se lit tel quel). */
  readonly spoken?: string;
  readonly kind: 'today' | 'countdown';
}

/** Étiquette du compte à rebours (E-04 critères 1, 2 et 7) pour n jours restants : 0 → « Aujourd'hui », n → « J-n » lue « dans n jours ». */
export function countdownTag(days: number): CountdownTag {
  if (days <= 0) return { label: t('events.tagToday'), kind: 'today' };
  const one = new Intl.PluralRules(getLocale()).select(days) === 'one';
  return { label: t('events.countdown.tag', { days }), spoken: one ? t('events.countdown.spokenOne') : t('events.countdown.spokenMany', { days }), kind: 'countdown' };
}
