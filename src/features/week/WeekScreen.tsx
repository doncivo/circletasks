import { useCallback, useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { resolveDefaultSpaceId } from '../../domain/taskRules';
import type { LocalDate, SpaceId } from '../../domain/types';
import { buildWeek, weekStartOf } from '../../domain/week';
import { t } from '../../i18n';
import { Fab, SpacePills, useDelayedFlag, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { TaskDetail } from '../tasks';
import { TodayCreateSheet, scheduleOf } from '../today/TodayCreate';
import { canToggleRoutines } from '../today/todaySources';
import { WeekDayView } from './WeekDayView';
import { WeekHeader } from './WeekHeader';
import { selectWeekTasks, weekStore } from './weekStore';
import './WeekScreen.css';

/**
 * Écran Semaine (M3, S-01) : sept colonnes de largeur égale sur PC, sept sections verticales sur iPhone, du lundi au dimanche.
 * Chaque jour assemble ses éléments comme Aujourd'hui (`buildWeek`) ; le jour courant est mis en évidence. Les tâches viennent de
 * la source unique (`taskEntities`) : une tâche modifiée depuis la fiche détail change de jour sans rechargement.
 */
export function WeekScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const fallbackSpaceId: SpaceId | null = spaces[0]?.id ?? null;
  const route = useNavigationStore((s) => s.route);
  const detail = useNavigationStore((s) => s.detail);
  const openDetail = useNavigationStore((s) => s.openDetail);
  const entities = useTaskEntities();

  const recurrences = useFeatureStore(weekStore, (s) => s.recurrences);
  const extras = useFeatureStore(weekStore, (s) => s.extras);
  const extrasFailed = useFeatureStore(weekStore, (s) => s.extrasFailed);
  const actionErrorKey = useFeatureStore(weekStore, (s) => s.actionErrorKey);
  const status = useFeatureStore(weekStore, (s) => s.status);
  const errorKey = useFeatureStore(weekStore, (s) => s.errorKey);
  const load = useFeatureStore(weekStore, (s) => s.load);
  const addTask = useFeatureStore(weekStore, (s) => s.addTask);
  const toggleDone = useFeatureStore(weekStore, (s) => s.toggleDone);
  const toggleRoutine = useFeatureStore(weekStore, (s) => s.toggleRoutine);
  const syncRecurrences = useFeatureStore(weekStore, (s) => s.syncRecurrences);

  // Jour courant de l'app (T-06) : suit le passage de minuit.
  const today: LocalDate = appDay ?? todayLocal(container.clock);
  // Semaine affichée : celle de la route, ou la semaine courante (lundi premier jour).
  const weekStart: LocalDate = route.tab === 'week' && route.weekStart ? route.weekStart : weekStartOf(today);

  useEffect(() => {
    void load(weekStart, spaceFilter);
    // `load` ne rejette jamais ; rechargé au changement de semaine, de filtre et au passage de minuit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, spaceFilter]);

  const tasks = useMemo(() => selectWeekTasks(entities, weekStart, spaceFilter), [entities, weekStart, spaceFilter]);
  const days = useMemo(() => buildWeek({ weekStart, filter: spaceFilter, tasks, extras }), [weekStart, spaceFilter, tasks, extras]);

  // T-09 : une règle posée depuis la fiche apparaît aussitôt sur la carte.
  const hasUnknownRule = tasks.some((task) => task.recurrenceId !== null && !recurrences.has(task.recurrenceId));
  useEffect(() => {
    if (hasUnknownRule) void syncRecurrences(tasks);
  }, [hasUnknownRule, tasks, syncRecurrences]);

  // Bouton « + » (feuille « Nouvelle tâche », T-01) : date présélectionnée = aujourd'hui ; Ctrl+N de même.
  const [sheetOpen, setSheetOpen] = useState(false);
  const openCreate = useCallback((): void => setSheetOpen(true), []);
  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  // Squelette si le chargement dépasse 150 ms (A-09).
  const showSkeleton = useDelayedFlag(status === 'loading', 150);

  const pills = <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />;
  const openedTaskId = layout === 'pc' && detail?.type === 'task' ? detail.id : null;

  return (
    <div className="ct-week" data-layout={layout}>
      <WeekHeader weekStart={weekStart} layout={layout} pills={pills} />

      {actionErrorKey && <p className="ct-week__error" role="alert">{t(actionErrorKey)}</p>}
      {extrasFailed && <p className="ct-week__error" role="alert">{t('week.sourceError')}</p>}
      {status === 'error' && errorKey && <p className="ct-week__error" role="alert">{t(errorKey)}</p>}

      {status === 'error' ? null : (
        <div className="ct-week__days" data-layout={layout} role="group" aria-label={t('week.daysLabel')} aria-busy={status === 'loading'}>
          {days.map((day) => (
            <WeekDayView
              key={day.date}
              day={day}
              layout={layout}
              isToday={day.date === today}
              spaces={spaces}
              showSpace={spaceFilter === 'all'}
              recurrences={recurrences}
              routinesCheckable={canToggleRoutines()}
              openedTaskId={openedTaskId}
              skeleton={showSkeleton}
              onToggleDone={(id) => void toggleDone(id)}
              onToggleRoutine={(id, date) => void toggleRoutine(id, date)}
              onOpen={(id) => openDetail({ type: 'task', id })}
            />
          ))}
        </div>
      )}
      {/* Annonce aux lecteurs d'écran : chargement (A-09) ; ni role="status" (réservé au bandeau « Annuler »). */}
      <div className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {showSkeleton ? t('status.loading') : ''}
      </div>

      <div className="ct-week__footer">
        <span className="ct-week__hint" />
        <Fab onClick={openCreate} label={t('common.add')} />
      </div>

      {sheetOpen && (
        <TodayCreateSheet
          viewedDate={today}
          today={today}
          spaces={spaces}
          initialSpaceId={fallbackSpaceId ? resolveDefaultSpaceId(spaceFilter, fallbackSpaceId) : null}
          onClose={() => setSheetOpen(false)}
          onCreate={async (input) => {
            const schedule = scheduleOf(input.choice);
            const result = await addTask({
              title: input.title,
              spaceId: input.spaceId,
              date: schedule.date ?? today,
              ...(schedule.someday ? { someday: true } : {}),
              ...(schedule.time !== undefined ? { time: schedule.time } : {}),
              recurrence: input.recurrence,
              icon: input.icon,
            });
            return result.ok;
          }}
        />
      )}

      <TaskDetail />
    </div>
  );
}
