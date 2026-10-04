import { focusTotalMinutes } from '../../domain/focusTotals';
import type { MonthReport } from '../../domain/monthReport';
import { t } from '../../i18n';
import { formatFocusDuration } from '../../i18n/formatFocus';
import { formatPercentLabel } from '../../i18n/formatStats';

/**
 * Les quatre tuiles du rapport (Rapport.html, H-01 critères 3 à 7) : tâches faites, routines, Focus, objectifs. Chaque tuile est un
 * groupe nommé (« Tâches faites : 48 sur 61 »). « — » quand il n'y a rien à rapporter.
 */
export function MonthTiles({ report }: { report: MonthReport }) {
  const { tasks, routines, focus, goals } = report;
  const noValue = t('stats.noValue');
  const routinesPercent = routines?.percent ?? null;
  return (
    <div className="ct-stats__tiles" role="group" aria-label={t('stats.tilesLabel')}>
      <div className="ct-stats__tile" role="group" aria-label={tasks.total > 0 ? t('stats.tasksAria', { done: tasks.done, total: tasks.total }) : t('stats.tasksNone')} data-tile="tasks">
        <span className="ct-stats__tileLabel" aria-hidden="true">
          {t('stats.tasksLabel')}
        </span>
        <span className="ct-stats__tileValue" aria-hidden="true">
          {tasks.total > 0 ? (
            <>
              {tasks.done} <span className="ct-stats__tileSub">{t('stats.tasksOf', { total: tasks.total })}</span>
            </>
          ) : (
            noValue
          )}
        </span>
      </div>
      <div
        className="ct-stats__tile"
        role="group"
        aria-label={routinesPercent !== null ? t('stats.routinesAria', { percent: routinesPercent }) : t('stats.routinesNone')}
        data-tile="routines"
      >
        <span className="ct-stats__tileLabel" aria-hidden="true">
          {t('stats.routinesLabel')}
        </span>
        <span className="ct-stats__tileValue" aria-hidden="true">
          {formatPercentLabel(routinesPercent)}
        </span>
      </div>
      <div className="ct-stats__tile" role="group" aria-label={t('stats.focusAria', { duration: formatFocusDuration(focusTotalMinutes(focus)) })} data-tile="focus">
        <span className="ct-stats__tileLabel" aria-hidden="true">
          {t('stats.focusLabel')}
        </span>
        <span className="ct-stats__tileValue" aria-hidden="true">
          {formatFocusDuration(focusTotalMinutes(focus))}
        </span>
      </div>
      <div
        className="ct-stats__tile"
        role="group"
        aria-label={goals ? t('stats.goalsAria', { achieved: goals.achieved, total: goals.total }) : t('stats.goalsNone')}
        data-tile="goals"
      >
        <span className="ct-stats__tileLabel" aria-hidden="true">
          {t('stats.goalsLabel')}
        </span>
        <span className="ct-stats__tileValue" aria-hidden="true">
          {goals ? (
            <>
              {goals.achieved} <span className="ct-stats__tileSub">{t('stats.goalsOf', { total: goals.total })}</span>
            </>
          ) : (
            noValue
          )}
        </span>
      </div>
    </div>
  );
}
