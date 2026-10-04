import { ArrowLeft, ArrowRight, ChevronRight, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import type { IsoDateTime } from '../../domain/types';
import { canShowNextMonth, canShowPreviousMonth, monthOf, sameMonth, shiftMonth, type MonthRef } from '../../domain/monthReport';
import { t } from '../../i18n';
import { formatMonthName, formatReportMonth } from '../../i18n/formatStats';
import { logDesktopFailure } from '../../platform';
import { EmptyState, Icon, useLayout } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { DEFAULT_ROUTES, useNavigationStore } from '../app/navigation';
import { FocusReportSection } from '../focus/FocusReportSection';
import { RoutinesMonthMap } from '../routines/RoutinesMonthMap';
import { SpaceFilterBar } from '../spaces';
import { CompletionSection } from './CompletionSection';
import { ExportButton, ExportDialog } from './ExportDialog';
import { MonthTiles } from './MonthTiles';
import { useMonthReport } from './useMonthReport';
import './ReportScreen.css';

export interface ReportScreenProps {
  /**
   * Écran d'où le rapport est ouvert : l'icône graphique d'Aujourd'hui (`tasks`) ou « Rapport du mois » des Routines (`routines`,
   * H-01 critère 10 : retour aux Routines et défilement jusqu'à la section routines).
   */
  readonly entry?: 'tasks' | 'routines';
}

/**
 * Rapport du mois (H-01, Rapport.html) : en-tête « Rapport du mois » + mois, flèches de mois, pastilles d'espace (et projet), quatre
 * tuiles (tâches faites, routines, Focus, objectifs), section CONCENTRATION (F-03), routines (R-06) et lien « Tâches terminées »
 * (T-07). Remplace l'écran minimal de T-07 ; ouvert par l'icône graphique d'Aujourd'hui et par « Rapport du mois » des Routines.
 */
export function ReportScreen({ entry = 'tasks' }: ReportScreenProps) {
  const container = useAppContainer();
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const appDay = useAppStore((s) => s.day);
  const currentDay = appDay ?? todayLocal(container.clock);
  const [month, setMonth] = useState<MonthRef>(() => monthOf(currentDay));
  const { report, status, today, oldest, filter } = useMonthReport(month);
  const spaces = useAppStore((state) => state.spaces);
  const projects = useAppStore((state) => state.projects);
  const [exporting, setExporting] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  const [exported, setExported] = useState<{ readonly path: string | undefined } | null>(null);
  const routinesHeading = useRef<HTMLHeadingElement>(null);
  const scrolled = useRef(false);

  const current = monthOf(today);
  const heading = formatReportMonth(month, current.year);
  // On n'affiche que le rapport du mois consulté (jamais celui du mois précédent pendant un changement de mois).
  const shown = report !== null && sameMonth(report.month, month) ? report : null;

  useEffect(() => {
    if (entry !== 'routines' || scrolled.current || shown === null || shown.heatmap === null) return;
    scrolled.current = true;
    routinesHeading.current?.scrollIntoView?.({ block: 'start' });
  }, [entry, shown]);

  const spaceName = filter.space === 'all' ? null : (spaces.find((space) => space.id === filter.space)?.name ?? null);
  const projectName = filter.project === null ? null : (projects.find((project) => project.id === filter.project)?.name ?? null);
  const filterLabel = [spaceName ?? t('spaces.all'), projectName].filter((part): part is string => part !== null).join(' · ');

  const back = entry === 'routines' ? DEFAULT_ROUTES.routines : DEFAULT_ROUTES.tasks;

  return (
    <div className="ct-stats" data-layout={layout}>
      <div className="ct-stats__topRow">
        <button type="button" className="ct-stats__iconButton" aria-label={t('report.back')} onClick={() => navigate(back)}>
          <Icon icon={Undo2} size={26} />
        </button>
      </div>
      <div className="ct-stats__headerRow">
        <div className="ct-stats__header">
          <span className="ct-stats__caption">{t('stats.caption')}</span>
          <h1 className="ct-stats__title">{heading}</h1>
        </div>
        <div className="ct-stats__nav">
          <button
            type="button"
            className="ct-stats__iconButton"
            aria-label={t('stats.previousMonth')}
            disabled={!canShowPreviousMonth(month, oldest)}
            onClick={() => setMonth((value) => shiftMonth(value, -1))}
          >
            <Icon icon={ArrowLeft} size={22} />
          </button>
          <button
            type="button"
            className="ct-stats__iconButton"
            aria-label={t('stats.nextMonth')}
            disabled={!canShowNextMonth(month, today)}
            onClick={() => setMonth((value) => shiftMonth(value, 1))}
          >
            <Icon icon={ArrowRight} size={22} />
          </button>
        </div>
      </div>
      <p className="ct-visually-hidden" role="status" aria-live="polite">
        {t('stats.monthAnnouncement', { month: heading })}
      </p>
      <div className="ct-stats__rule" aria-hidden="true">
        <div className="ct-stats__ruleAccent" />
        <div className="ct-stats__ruleLine" />
      </div>
      <div className="ct-stats__filters">
        <SpaceFilterBar />
        {shown !== null && <ExportButton files={container.files} onClick={() => setExporting(true)} />}
      </div>

      {exported !== null && (
        <p className="ct-stats__exported" role="status">
          <span>{t('stats.exportDone')}</span>
          {exported.path !== undefined && container.files.reveal && (
            <button
              type="button"
              className="ct-stats__exportedAction"
              onClick={() => {
                setRevealFailed(false);
                container.files.reveal?.(exported.path ?? '').catch((error: unknown) => {
                  // Journal sans le chemin (nom de fichier et dossiers de l'utilisateur).
                  logDesktopFailure('export-reveal', new Error(error instanceof Error ? error.name : 'erreur'));
                  setRevealFailed(true);
                });
              }}
            >
              {t('stats.exportReveal')}
            </button>
          )}
        </p>
      )}
      {revealFailed && (
        <p className="ct-stats__error" role="alert">
          {t('stats.exportRevealError')}
        </p>
      )}
      {exporting && shown !== null && (
        <ExportDialog
          files={container.files}
          context={{ data: container.data, filter, month, today, now: new Date(container.clock.nowMs()).toISOString() as IsoDateTime, report: shown, spaceName, projectName, filterLabel }}
          onClose={() => setExporting(false)}
          onDone={(path) => {
            setExporting(false);
            setRevealFailed(false);
            setExported({ path });
          }}
        />
      )}

      {status === 'error' && (
        <p className="ct-stats__error" role="alert">
          {t('stats.loadError')}
        </p>
      )}

      {shown !== null && shown.isEmpty && (
        <EmptyState
          screen="report"
          title={t('stats.emptyTitle', { month: formatMonthName(month) })}
          action={{ label: t('empty.goToToday'), onClick: () => navigate(DEFAULT_ROUTES.tasks) }}
        />
      )}
      {shown !== null && !shown.isEmpty && (
        <>
          <MonthTiles report={shown} />
          <FocusReportSection month={month} />
          <div className="ct-stats__charts">
            <CompletionSection report={shown} />
            {shown.heatmap !== null && (
              <div className="ct-stats__routinesBlock">
                <RoutinesMonthMap aggregate={shown.heatmap} rates={shown.routineRates} headingRef={routinesHeading} />
              </div>
            )}
            {shown.heatmap === null && entry === 'routines' && (
              <p className="ct-stats__note" data-testid="routines-no-project">
                {t('stats.routinesNoProject')}
              </p>
            )}
          </div>
        </>
      )}
      {shown !== null && (
        <button type="button" className="ct-stats__link" onClick={() => navigate({ tab: 'tasks', screen: 'done' })}>
          <span>{t('report.openDone')}</span>
          <Icon icon={ChevronRight} size={20} />
        </button>
      )}
    </div>
  );
}
