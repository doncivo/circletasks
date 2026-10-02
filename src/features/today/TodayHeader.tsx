import { ArrowLeft, ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatTodayHeader } from '../../i18n/format';
import { Icon, type Layout } from '../../ui';

export interface TodayHeaderProps {
  /** Jour affiché. */
  date: LocalDate;
  /** Jour courant : le badge « AUJOURD'HUI » n'apparaît que si `date` en est un (Q10). */
  today: LocalDate;
  layout: Layout;
  /** Flèches « Jour précédent / Jour suivant » : PC seulement (Q10), absentes de l'iPhone. */
  onPreviousDay?: () => void;
  onNextDay?: () => void;
  /** Boutons de droite (vue compacte, A-06). */
  actions?: ReactNode;
}

/**
 * En-tête d'Aujourd'hui (A-01, Main.html / PC-Aujourdhui.html) : mois, jour en grand (Fraunces), badge
 * « AUJOURD'HUI » sur le jour courant seulement, flèches de jour sur PC, filet décoratif.
 */
export function TodayHeader({ date, today, layout, onPreviousDay, onNextDay, actions }: TodayHeaderProps) {
  const header = formatTodayHeader(date, layout === 'pc' ? 'long' : 'short');
  return (
    <>
      <div className="ct-today__headerRow">
        <div className="ct-today__header">
          <span className="ct-today__month">{header.monthLine}</span>
          <div className="ct-today__dateRow">
            <h1 className="ct-today__day">{header.dayLine}</h1>
            {date === today && <span className="ct-today__badge">{t('tasks.todayBadge')}</span>}
          </div>
        </div>
        <div className="ct-today__headerActions">
          {layout === 'pc' && onPreviousDay && onNextDay && (
            <>
              <button type="button" className="ct-today__iconButton" aria-label={t('today.dayPrevious')} onClick={onPreviousDay}>
                <Icon icon={ArrowLeft} size={24} />
              </button>
              <button type="button" className="ct-today__iconButton" aria-label={t('today.dayNext')} onClick={onNextDay}>
                <Icon icon={ArrowRight} size={24} />
              </button>
            </>
          )}
          {actions}
        </div>
      </div>
      <div className="ct-today__rule" aria-hidden="true">
        <div className="ct-today__ruleAccent" />
        <div className="ct-today__ruleLine" />
      </div>
    </>
  );
}
