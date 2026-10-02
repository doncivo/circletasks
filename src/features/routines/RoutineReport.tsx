import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseLocalDate } from '../../domain/localDate';
import type { Routine, Space } from '../../domain/model';
import { completionRate, formatPercent, monthHeatmap, type HeatmapState } from '../../domain/routineReport';
import type { DateInterval } from '../../domain/routineSchedule';
import { computeStreaks } from '../../domain/routineStreaks';
import type { LocalDate } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { formatDayAria, formatMonthTitle, weekdayInitials } from '../../i18n/format';
import { formatStreak, scheduleLong } from '../../i18n/formatRoutine';
import { Button, Icon, IconView, resolveIconRefColor } from '../../ui';
import './RoutineReport.css';

export interface RoutineReportProps {
  readonly routine: Routine;
  readonly spaces: readonly Space[];
  /** Dates validées de la routine (historique complet : archivées comprises, R-05 critère 6). */
  readonly done: ReadonlySet<LocalDate>;
  /** Périodes de pause de la routine. */
  readonly pauses: readonly DateInterval[];
  readonly today: LocalDate;
  /** Boutons du bas : « Mettre en pause / Reprendre », « Archiver », « Modifier » (absent sur iPhone : « Éditer » de la carte est le seul accès au formulaire, QB-06). */
  readonly onTogglePause: () => void;
  readonly onArchive: () => void;
  readonly onModify?: () => void;
  /** Bouton « Fermer » de l'en-tête. */
  readonly onClose: () => void;
}

const RATE_PERIODS = [
  { days: 7, labelKey: 'routines.report.rate7' },
  { days: 30, labelKey: 'routines.report.rate30' },
  { days: 90, labelKey: 'routines.report.rate90' },
] as const;

const CELL_LABEL_KEYS: { readonly [S in HeatmapState]: 'routines.report.cellDone' | 'routines.report.cellMissed' | 'routines.report.cellUpcoming' | 'routines.report.cellNone' } = {
  done: 'routines.report.cellDone',
  missed: 'routines.report.cellMissed',
  upcoming: 'routines.report.cellUpcoming',
  none: 'routines.report.cellNone',
};

/**
 * Rapport d'une routine (R-06, PC-Routines.html) : taux sur 7, 30 et 90 jours, série en cours et meilleure série, carte de chaleur
 * du mois avec flèches de mois (jamais au-delà du mois courant), actions. Même contenu dans le panneau PC et la feuille iPhone.
 * Tout est calculé à l'affichage par src/domain.
 */
export function RoutineReport({ routine, spaces, done, pauses, today, onTogglePause, onArchive, onModify, onClose }: RoutineReportProps) {
  const current = parseLocalDate(today);
  const [month, setMonth] = useState({ year: current.year, month: current.month });
  const rates = useMemo(() => RATE_PERIODS.map(({ days }) => completionRate(routine, done, today, days, pauses)), [routine, done, today, pauses]);
  const streaks = useMemo(() => computeStreaks(routine, done, today, pauses), [routine, done, today, pauses]);
  const heatmap = useMemo(() => monthHeatmap(routine, done, month.year, month.month, today, pauses), [routine, done, month, today, pauses]);
  const spaceName = spaces.find((space) => space.id === routine.spaceId)?.name ?? '';
  const schedule = scheduleLong(routine);
  const subtitle = routine.time ? t('routines.report.subtitleAt', { schedule, time: routine.time, space: spaceName }) : t('routines.report.subtitle', { schedule, space: spaceName });
  const color = routine.icon ? resolveIconRefColor(routine.icon) : undefined;
  const atCurrentMonth = month.year === current.year && month.month === current.month;
  const initials = weekdayInitials();

  function shiftMonth(delta: -1 | 1): void {
    setMonth(({ year, month: m }) => {
      const index = year * 12 + (m - 1) + delta;
      const next = { year: Math.floor(index / 12), month: (index % 12) + 1 };
      // Pas de mois au-delà du mois courant (critère 4).
      return next.year * 12 + next.month > current.year * 12 + current.month ? { year, month: m } : next;
    });
  }

  return (
    <div className="ct-routine-report">
      <div className="ct-routine-report__header">
        <span className="ct-routine-report__caption">{t('routines.report.caption')}</span>
        <button type="button" className="ct-routine-report__close" aria-label={t('routines.report.close')} onClick={onClose}>
          <Icon icon={X} size={22} />
        </button>
      </div>
      <div className="ct-routine-report__title">
        {routine.icon && <IconView icon={routine.icon} color={color ?? 'currentColor'} size={40} />}
        <h2 className="ct-routine-report__name">{routine.title}</h2>
      </div>
      <span className="ct-routine-report__subtitle">{subtitle}</span>

      <div className="ct-routine-report__tiles">
        {RATE_PERIODS.map(({ days, labelKey }, index) => {
          const rate = rates[index];
          const value = rate ? formatPercent(rate) : '—';
          return (
            <div key={days} className="ct-routine-report__tile" role="group" aria-label={t('routines.report.rateLabel', { days, value })}>
              <span className="ct-routine-report__tileLabel" aria-hidden="true">
                {t(labelKey)}
              </span>
              <span className="ct-routine-report__tileValue" aria-hidden="true">
                {value}
              </span>
            </div>
          );
        })}
      </div>

      <div className="ct-routine-report__streaks">
        <div className="ct-routine-report__streak">
          <span className="ct-routine-report__streakLabel">{t('routines.streak.current')}</span>
          <b>{formatStreak(streaks.current, streaks.unit)}</b>
        </div>
        <div className="ct-routine-report__streak">
          <span className="ct-routine-report__streakLabel">{t('routines.streak.best')}</span>
          <b>{formatStreak(streaks.best, streaks.unit)}</b>
        </div>
      </div>

      <div className="ct-routine-report__monthRow">
        <span className="ct-routine-report__month" aria-live="polite">
          {formatMonthTitle(month.year, month.month).toLocaleUpperCase(getLocale() === 'fr' ? 'fr-FR' : 'en-US')}
        </span>
        <div className="ct-routine-report__months">
          <button type="button" className="ct-routine-report__monthButton" aria-label={t('routines.report.previousMonth')} onClick={() => shiftMonth(-1)}>
            <Icon icon={ArrowLeft} size={20} />
          </button>
          <button type="button" className="ct-routine-report__monthButton" aria-label={t('routines.report.nextMonth')} disabled={atCurrentMonth} onClick={() => shiftMonth(1)}>
            <Icon icon={ArrowRight} size={20} />
          </button>
        </div>
      </div>
      <div className="ct-routine-report__grid" role="group" aria-label={t('routines.report.heatmapLabel')}>
        {initials.map((letter, index) => (
          <span key={index} className="ct-routine-report__weekday" aria-hidden="true">
            {letter}
          </span>
        ))}
        {Array.from({ length: heatmap.leadingBlanks }, (_, index) => (
          <span key={`blank-${String(index)}`} className="ct-routine-report__blank" aria-hidden="true" />
        ))}
        {heatmap.cells.map((cell) => (
          <div
            key={cell.date}
            role="img"
            aria-label={t(CELL_LABEL_KEYS[cell.state], { date: formatDayAria(cell.date) })}
            className="ct-routine-report__cell"
            data-state={cell.state}
            data-today={cell.isToday}
            data-date={cell.date}
          >
            {cell.day}
          </div>
        ))}
      </div>

      <div className="ct-routine-report__spacer" />
      <div className="ct-routine-report__actions">
        <Button variant="secondary" onClick={onTogglePause}>
          {t(routine.paused ? 'routines.report.resume' : 'routines.report.pause')}
        </Button>
        <Button variant="secondary" onClick={onArchive}>
          {t('routines.report.archive')}
        </Button>
        {onModify && (
          <Button className="ct-routine-report__modify" onClick={onModify}>
            {t('routines.report.modify')}
          </Button>
        )}
      </div>
    </div>
  );
}
