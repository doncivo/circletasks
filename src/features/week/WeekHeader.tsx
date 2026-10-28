import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { addDays, parseLocalDate } from '../../domain/localDate';
import type { LocalDate } from '../../domain/types';
import { isoWeekOf } from '../../domain/week';
import type { WeekSummary } from '../../domain/weekSummary';
import { t } from '../../i18n';
import { formatWeekRange } from '../../i18n/format';
import { formatWeekCounts, tWeekRefonte } from '../../i18n/weekRefonteText';
import { Icon, useFitText, type Layout } from '../../ui';

export interface WeekHeaderProps {
  readonly weekStart: LocalDate;
  readonly layout: Layout;
  /** Pastilles Pro / Perso / Tout (à droite sur PC, sous le filet sur iPhone). */
  readonly pills: ReactNode;
  /** La semaine affichée est la semaine courante : « Cette semaine » est inactif sur PC (S-03 critère 4), absent sur iPhone (UI-REFONTE-03). */
  readonly isCurrent: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  readonly onCurrent: () => void;
  /** Bouton « Un jour » (PC, S-06) à droite de la flèche « Semaine suivante » : affiche le panneau à droite de la grille. */
  readonly somedayToggle?: ReactNode;
  /** Plage en forme courte (« 21 – 27 sept. 2026 ») : le panneau « Un jour » réduit la place du titre (S-06). */
  readonly shortRange?: boolean;
  /** iPhone (UI-REFONTE-03) : jour courant (l'année n'est écrite que hors de l'année courante) et synthèse de la semaine ; null : semaine en chargement. */
  readonly today?: LocalDate;
  readonly summary?: WeekSummary | null;
}

/**
 * En-tête de la Semaine (S-01, S-03). PC (PC-Semaine.html) : « Semaine 39 » au-dessus de la plage en grand (Fraunces), flèches
 * « Semaine précédente / suivante » et pastille « Cette semaine » à droite des pastilles d'espace, puis le filet décoratif.
 * iPhone (UI-REFONTE-03, Semaine-v2.html) : « semaine 39 » en petit gris (« semaine 1 · 2027 » hors de l'année courante), plage courte,
 * flèches à droite du titre, ligne de synthèse « 8 tâches restantes · 6 faites · 1 en retard » sous un filet, pastilles d'espace et
 * « Cette semaine » seulement hors de la semaine courante ; plus de filet décoratif.
 */
export function WeekHeader({ weekStart, layout, pills, isCurrent, onPrevious, onNext, onCurrent, somedayToggle, shortRange = false, today, summary = null }: WeekHeaderProps) {
  const { week, year } = isoWeekOf(addDays(weekStart, 3));
  const mobile = layout === 'mobile';
  const currentYear = today ? parseLocalDate(today).year : year;
  const caption = !mobile ? t('week.title', { number: week }) : year === currentYear ? tWeekRefonte('caption', { number: week }) : tWeekRefonte('captionYear', { number: week, year });
  const range = formatWeekRange(weekStart, addDays(weekStart, 6), layout === 'pc' && !shortRange ? 'long' : 'short');
  const size = layout === 'pc' ? 22 : 24;
  const rowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Plage sur une ligne, réduite à la place laissée par les flèches (« 28 sept. – 4 oct. » sur iPhone ; IOS-titres).
  useFitText(titleRef, rowRef, range);
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
      <div className="ct-week__headerRow" data-layout={layout} ref={rowRef}>
        <div className="ct-week__heading">
          <span className="ct-week__caption">{caption}</span>
          <h1 className="ct-week__range" ref={titleRef}>
            {range}
          </h1>
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
      {mobile ? (
        <>
          {/* Synthèse (critère 2) : tâches seulement, sur les sept jours et le filtre courant ; « en retard » en rouge, absent à zéro. */}
          {summary && (
            <p className="ct-week__summary">
              {summary.total === 0 ? (
                tWeekRefonte('summaryEmpty')
              ) : (
                <>
                  {formatWeekCounts(summary.remaining, summary.done)}
                  {summary.late > 0 && (
                    <>
                      {' · '}
                      <span className="ct-week__summaryLate">{tWeekRefonte('late', { count: summary.late })}</span>
                    </>
                  )}
                </>
              )}
            </p>
          )}
          <div className="ct-week__pillsRow">
            {pills}
            {/* Règle 3 des refontes : aucune commande qui ne peut rien faire ; « Cette semaine » n'apparaît que hors de la semaine courante. */}
            {!isCurrent && current}
          </div>
        </>
      ) : (
        <div className="ct-week__rule" aria-hidden="true">
          <div className="ct-week__ruleAccent" />
          <div className="ct-week__ruleLine" />
        </div>
      )}
    </>
  );
}
