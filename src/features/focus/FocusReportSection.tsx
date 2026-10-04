import { useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { daySpan, focusTotalMinutes, monthSpan, weekSpan, type FocusTaskTotal, type FocusTotal } from '../../domain/focusTotals';
import type { ItemFilter } from '../../domain/itemFilter';
import { firstDayOf, monthOf, sameMonth, type MonthRef } from '../../domain/monthReport';
import { t } from '../../i18n';
import { formatFocusDuration } from '../../i18n/formatFocus';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { formatReportMonth } from '../../i18n/formatStats';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useEffectiveProjectFilter } from '../spaces';
import { focusStore } from './focusStore';
import './FocusReportSection.css';

/** Nombre de tâches listées (F-03 critère 4). */
const TOP_TASKS = 5;

interface ReportData {
  readonly today: FocusTotal;
  readonly week: FocusTotal;
  readonly month: FocusTotal;
  readonly top: readonly { readonly total: FocusTaskTotal; readonly title: string | null }[];
}

/**
 * Section « CONCENTRATION » du rapport (F-03 critère 4, lignes « .rr » de Rapport.html) : aujourd'hui, cette semaine (premier jour
 * choisi dans Réglages, P-03), ce mois, et les cinq tâches les plus travaillées du mois. Elle suit le filtre d'espace global et le filtre
 * de projet (ES-08) et se recalcule aussitôt. Totaux fournis par le repository (agrégats SQL) : stats-history (H-01) les réutilise tels
 * quels pour la tuile « FOCUS ».
 */
export function FocusReportSection({ month }: { readonly month?: MonthRef } = {}) {
  const container = useAppContainer();
  const space = useAppStore((s) => s.spaceFilter);
  const project = useEffectiveProjectFilter();
  const currentDay = useAppStore((s) => s.day) ?? todayLocal(container.clock);
  // H-01 : le rapport d'un autre mois n'affiche que le total de ce mois (« aujourd'hui » et « cette semaine » n'y ont pas de sens).
  const monthOnly = month !== undefined && !sameMonth(month, monthOf(currentDay));
  const day = monthOnly ? firstDayOf(month) : currentDay;
  const revision = useFeatureStore(focusStore, (s) => s.revision);
  const firstWeekday = getFirstWeekday();
  const filter: ItemFilter = useMemo(() => ({ space, project }), [space, project]);
  const [data, setData] = useState<ReportData | null>(null);

  useEffect(() => {
    let alive = true;
    const repo = container.data.repos.focusSessions;
    void (async () => {
      try {
        const span = monthSpan(day);
        const [today, week, monthTotal, top] = await Promise.all([
          repo.totals({ span: daySpan(day), filter }),
          repo.totals({ span: weekSpan(day, firstWeekday), filter }),
          repo.totals({ span, filter }),
          repo.totalsByTask({ span, filter }, TOP_TASKS),
        ]);
        // Titre lu même pour une tâche à la corbeille ; une tâche supprimée pour de bon garde sa ligne (la session reste comptée).
        const titled = await Promise.all(
          top.map(async (total) => ({ total, title: (await container.data.repos.tasks.getById(total.taskId, { includeDeleted: true }))?.title ?? null })),
        );
        if (alive) setData({ today, week, month: monthTotal, top: titled });
      } catch {
        if (alive) setData(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [container, day, filter, firstWeekday, revision]);

  if (!data) return null;
  const rows: readonly [string, FocusTotal][] = monthOnly
    ? [[formatReportMonth(month, monthOf(currentDay).year), data.month]]
    : [
        [t('focus.reportToday'), data.today],
        [t('focus.reportWeek'), data.week],
        [t('focus.reportMonth'), data.month],
      ];
  return (
    <section className="ct-focus-report" aria-labelledby="ct-focus-report-title">
      <h2 id="ct-focus-report-title" className="ct-focus-report__title">
        {t('focus.reportSection')}
      </h2>
      <ul className="ct-focus-report__list">
        {rows.map(([label, total]) => (
          <li key={label} className="ct-focus-report__row">
            <span>{label}</span>
            <span className="ct-focus-report__value">{formatFocusDuration(focusTotalMinutes(total))}</span>
          </li>
        ))}
      </ul>
      {data.top.length > 0 && (
        <ul className="ct-focus-report__list" aria-label={t('focus.reportTopTasks')}>
          {data.top.map(({ total, title }) => (
            <li key={total.taskId} className="ct-focus-report__row">
              <span className="ct-focus-report__task">{title ?? t('focus.reportTaskGone')}</span>
              <span className="ct-focus-report__value">{formatFocusDuration(focusTotalMinutes(total))}</span>
            </li>
          ))}
        </ul>
      )}
      {data.month.sessions === 0 && <p className="ct-focus-report__empty">{t('focus.reportEmpty')}</p>}
    </section>
  );
}
