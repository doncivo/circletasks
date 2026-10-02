import type { ReactNode } from 'react';
import { isoWeekOf } from '../../domain/week';
import type { LocalDate } from '../../domain/types';
import { addDays } from '../../domain/localDate';
import { t } from '../../i18n';
import { formatWeekRange } from '../../i18n/format';
import type { Layout } from '../../ui';

export interface WeekHeaderProps {
  readonly weekStart: LocalDate;
  readonly layout: Layout;
  /** Pastilles Pro / Perso / Tout (à droite sur PC, sous le filet sur iPhone). */
  readonly pills: ReactNode;
  /** Flèches et « Cette semaine » (S-03). */
  readonly nav?: ReactNode;
}

/**
 * En-tête de la Semaine (S-01, PC-Semaine.html / Semaine.html) : « Semaine 39 » (« Semaine 39 · 2026 » sur iPhone) au-dessus de la
 * plage en grand (Fraunces), puis le filet décoratif. Le titre est annoncé aux lecteurs d'écran à chaque changement de semaine.
 */
export function WeekHeader({ weekStart, layout, pills, nav }: WeekHeaderProps) {
  const { week, year } = isoWeekOf(weekStart);
  const caption = layout === 'pc' ? t('week.title', { number: week }) : t('week.titleYear', { number: week, year });
  const range = formatWeekRange(weekStart, addDays(weekStart, 6), layout === 'pc' ? 'long' : 'short');
  return (
    <>
      <div className="ct-week__headerRow" data-layout={layout}>
        <div className="ct-week__heading">
          <span className="ct-week__caption">{caption}</span>
          <h1 className="ct-week__range">{range}</h1>
        </div>
        {layout === 'pc' ? (
          <div className="ct-week__tools">
            {pills}
            {nav}
          </div>
        ) : (
          nav
        )}
      </div>
      <div className="ct-week__rule" aria-hidden="true">
        <div className="ct-week__ruleAccent" />
        <div className="ct-week__ruleLine" />
      </div>
      {layout === 'mobile' && <div className="ct-week__pillsRow">{pills}</div>}
    </>
  );
}
