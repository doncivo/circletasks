import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { addDays } from '../../domain/localDate';
import type { LocalDate } from '../../domain/types';
import { isoWeekOf } from '../../domain/week';
import { t } from '../../i18n';
import { formatWeekRange } from '../../i18n/format';
import { Icon, type Layout } from '../../ui';

export interface WeekHeaderProps {
  readonly weekStart: LocalDate;
  readonly layout: Layout;
  /** Pastilles Pro / Perso / Tout (à droite sur PC, sous le filet sur iPhone). */
  readonly pills: ReactNode;
  /** La semaine affichée est la semaine courante : « Cette semaine » est inactif (S-03 critère 4). */
  readonly isCurrent: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onCurrent: () => void;
  /** Bouton « Un jour » (PC, S-06) à droite de la flèche « Semaine suivante » : affiche le panneau à droite de la grille. */
  readonly somedayToggle?: ReactNode;
  /** Plage en forme courte (« 21 – 27 sept. 2026 ») : le panneau « Un jour » réduit la place du titre (S-06). */
  readonly shortRange?: boolean;
}

/**
 * En-tête de la Semaine (S-01, S-03 ; PC-Semaine.html / Semaine.html) : « Semaine 39 » (« Semaine 39 · 2026 » sur iPhone) au-dessus de
 * la plage en grand (Fraunces), flèches « Semaine précédente / suivante » et pastille « Cette semaine » (PC : à droite des pastilles
 * d'espace, entre les flèches ; iPhone : flèches à droite du titre, pastille à droite des pastilles d'espace), puis le filet décoratif.
 */
export function WeekHeader({ weekStart, layout, pills, isCurrent, onPrevious, onNext, onCurrent, somedayToggle, shortRange = false }: WeekHeaderProps) {
  const { week, year } = isoWeekOf(weekStart);
  const caption = layout === 'pc' ? t('week.title', { number: week }) : t('week.titleYear', { number: week, year });
  const range = formatWeekRange(weekStart, addDays(weekStart, 6), layout === 'pc' && !shortRange ? 'long' : 'short');
  const size = layout === 'pc' ? 22 : 24;
  const previous = (
    <button type="button" className="ct-week__iconButton" aria-label={t('week.previous')} onClick={onPrevious}>
      <Icon icon={ArrowLeft} size={size} />
    </button>
  );
  const next = (
    <button type="button" className="ct-week__iconButton" aria-label={t('week.next')} onClick={onNext}>
      <Icon icon={ArrowRight} size={size} />
    </button>
  );
  // Semaine courante : la pastille reste visible mais inactive (aria-disabled, pas `disabled` : elle garde le focus au clavier).
  const current = (
    <button type="button" className="ct-week__pill" aria-disabled={isCurrent} onClick={() => !isCurrent && onCurrent()}>
      {t('week.current')}
    </button>
  );
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
            <span className="ct-week__toolsGap" />
            {previous}
            {current}
            {next}
            {somedayToggle}
          </div>
        ) : (
          <div className="ct-week__arrows">
            {previous}
            {next}
          </div>
        )}
      </div>
      <div className="ct-week__rule" aria-hidden="true">
        <div className="ct-week__ruleAccent" />
        <div className="ct-week__ruleLine" />
      </div>
      {layout === 'mobile' && (
        <div className="ct-week__pillsRow">
          {pills}
          {current}
        </div>
      )}
    </>
  );
}
