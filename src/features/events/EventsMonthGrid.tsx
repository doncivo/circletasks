import { ChevronLeft, ChevronRight } from 'lucide-react';
import { monthGrid } from '../../domain/calendarMonth';
import type { DayDot } from '../../domain/eventList';
import { parseLocalDate } from '../../domain/localDate';
import type { Space } from '../../domain/model';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatDayAria, formatMonthTitle, weekdayInitials } from '../../i18n/format';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { Icon, spaceTextColor } from '../../ui';

export interface EventsMonthGridProps {
  readonly year: number;
  /** 1 à 12. */
  readonly month: number;
  readonly today: LocalDate;
  readonly spaces: readonly Space[];
  readonly dots: ReadonlyMap<LocalDate, readonly DayDot[]>;
  readonly selected: LocalDate | null;
  readonly onSelect: (date: LocalDate) => void;
  readonly onMonthChange: (delta: -1 | 1) => void;
}

/** Couleur d'un point (E-01 D6) : celle de l'espace ; bleu des agendas pour un agenda sans espace ; vert pour les jours fériés. */
function dotColor(dot: DayDot, spaces: readonly Space[]): string {
  if (dot.source === 'holiday') return 'var(--ct-color-achieved-text)';
  const space = spaces.find((candidate) => candidate.id === dot.spaceId);
  return space ? spaceTextColor(space.color) : 'var(--ct-color-event-text)';
}

/**
 * Grille du mois (PC-Evenements.html, volet droit « Septembre 2026 » ; iPhone : feuille « Calendrier ») : jours L M M J V S D, un point
 * par espace et par jour concerné, aujourd'hui sur fond foncé. Toucher un jour le choisit : la liste défile jusqu'à lui (critère 8).
 */
export function EventsMonthGrid({ year, month, today, spaces, dots, selected, onSelect, onMonthChange }: EventsMonthGridProps) {
  const cells = monthGrid(year, month, getFirstWeekday());
  const initials = weekdayInitials();
  return (
    <section className="ct-events-grid" aria-label={t('events.calendarLabel')}>
      <div className="ct-events-grid__header">
        <h2 className="ct-events-grid__title">{formatMonthTitle(year, month)}</h2>
        <div className="ct-events-grid__nav">
          <button type="button" className="ct-events-grid__arrow" aria-label={t('events.aside.monthPrevious')} onClick={() => onMonthChange(-1)}>
            <Icon icon={ChevronLeft} />
          </button>
          <button type="button" className="ct-events-grid__arrow" aria-label={t('events.aside.monthNext')} onClick={() => onMonthChange(1)}>
            <Icon icon={ChevronRight} />
          </button>
        </div>
      </div>
      <div className="ct-events-grid__days" role="group" aria-label={formatMonthTitle(year, month)}>
        {initials.map((initial, index) => (
          <span key={index} className="ct-events-grid__initial" aria-hidden="true">
            {initial}
          </span>
        ))}
        {cells.map((date, index) => {
          if (date === null) return <span key={`empty-${index}`} className="ct-events-grid__cell" aria-hidden="true" />;
          const dayDots = dots.get(date) ?? [];
          const label = dayDots.length > 0 ? t('events.aside.dayWithEvents', { day: formatDayAria(date) }) : formatDayAria(date);
          return (
            <button
              key={date}
              type="button"
              className="ct-events-grid__cell ct-events-grid__day"
              data-today={date === today || undefined}
              data-selected={date === selected || undefined}
              aria-label={label}
              aria-current={date === today ? 'date' : undefined}
              onClick={() => onSelect(date)}
            >
              <span aria-hidden="true">{parseLocalDate(date).day}</span>
              <span className="ct-events-grid__dots" aria-hidden="true">
                {dayDots.map((dot) => (
                  <span key={`${dot.source}-${dot.spaceId ?? ''}`} className="ct-events-grid__dot" data-testid="event-dot" style={{ background: date === today ? 'var(--ct-color-accent-on)' : dotColor(dot, spaces) }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
