import { useDefaultReminderOffsets } from '../reminders';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { resolveDefaultSpaceId } from '../../domain/taskRules';
import type { LocalDate, SpaceId } from '../../domain/types';
import { externalEventsByDay } from '../../domain/externalEvents';
import { addWeeks, buildWeek, isoWeekOf, weekDays, weekStartOf } from '../../domain/week';
import { detectTimeZone } from '../../platform';
import { t } from '../../i18n';
import { addDays } from '../../domain/localDate';
import { formatWeekRange } from '../../i18n/format';
import { Fab, SpacePills, useDelayedFlag, useLayout, useSwipe } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { isModalOpen } from '../app/tabShortcuts';
import { TaskDetail } from '../tasks';
import { TodayCreateSheet, scheduleOf } from '../today/TodayCreate';
import { canToggleRoutines, subscribeToTodaySources } from '../today/todaySources';
import { ExternalEventDetail } from './ExternalEventDetail';
import { WeekDayView } from './WeekDayView';
import { WeekHeader } from './WeekHeader';
import { useWeekMoves } from './useWeekMoves';
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
  const navigate = useNavigationStore((s) => s.navigate);
  const entities = useTaskEntities();

  const recurrences = useFeatureStore(weekStore, (s) => s.recurrences);
  const extras = useFeatureStore(weekStore, (s) => s.extras);
  const externalEvents = useFeatureStore(weekStore, (s) => s.externalEvents);
  const calendarAccounts = useFeatureStore(weekStore, (s) => s.calendarAccounts);
  const extrasFailed = useFeatureStore(weekStore, (s) => s.extrasFailed);
  const actionErrorKey = useFeatureStore(weekStore, (s) => s.actionErrorKey);
  const status = useFeatureStore(weekStore, (s) => s.status);
  const errorKey = useFeatureStore(weekStore, (s) => s.errorKey);
  const load = useFeatureStore(weekStore, (s) => s.load);
  const addTask = useFeatureStore(weekStore, (s) => s.addTask);
  const toggleDone = useFeatureStore(weekStore, (s) => s.toggleDone);
  const toggleRoutine = useFeatureStore(weekStore, (s) => s.toggleRoutine);
  const refreshExtras = useFeatureStore(weekStore, (s) => s.refreshExtras);
  const syncRecurrences = useFeatureStore(weekStore, (s) => s.syncRecurrences);

  // Jour courant de l'app (T-06) : suit le passage de minuit.
  const today: LocalDate = appDay ?? todayLocal(container.clock);
  // Semaine affichée : celle de la route, ou la semaine courante (lundi premier jour).
  const weekStart: LocalDate = route.tab === 'week' && route.weekStart ? route.weekStart : weekStartOf(today);

  const currentWeekStart = weekStartOf(today);
  const isCurrentWeek = weekStart === currentWeekStart;

  // S-03 : changer de semaine = naviguer vers la route (la dernière semaine consultée est conservée par onglet pendant la session ;
  // au redémarrage, `weekStart` null = semaine courante). La semaine courante est toujours notée null : elle suit minuit.
  const [direction, setDirection] = useState<'next' | 'previous' | null>(null);
  const goToWeek = useCallback(
    (target: LocalDate, way: 'next' | 'previous' | null): void => {
      setDirection(way);
      navigate({ tab: 'week', weekStart: target === currentWeekStart ? null : target, somedayPanel: route.tab === 'week' ? route.somedayPanel : false });
    },
    [navigate, currentWeekStart, route],
  );
  const shiftWeek = useCallback((delta: 1 | -1): void => goToWeek(addWeeks(weekStart, delta), delta === 1 ? 'next' : 'previous'), [goToWeek, weekStart]);

  // Ctrl+← / Ctrl+→ (registre de raccourcis, hors champ de saisie) ; ignorés sous une feuille ou une fenêtre modale.
  useEffect(() => {
    const guarded = (delta: 1 | -1) => (): void => {
      if (!isModalOpen()) shiftWeek(delta);
    };
    const offs = [container.shortcuts.register('week.previous', guarded(-1)), container.shortcuts.register('week.next', guarded(1))];
    return () => {
      for (const off of offs) off();
    };
  }, [container, shiftWeek]);

  useEffect(() => {
    void load(weekStart, spaceFilter);
    // `load` ne rejette jamais ; rechargé au changement de semaine, de filtre et au passage de minuit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, spaceFilter]);

  const tasks = useMemo(() => selectWeekTasks(entities, weekStart, spaceFilter), [entities, weekStart, spaceFilter]);
  // Événements des agendas externes (S-05) : convertis dans le fuseau COURANT de l'appareil à chaque rendu utile, donc recalés
  // aussitôt qu'il change (T-11) ; filtrés par l'espace de leur agenda (ES-06).
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const external = useMemo(
    () => externalEventsByDay({ days: weekDays(weekStart), events: externalEvents, accounts: calendarAccounts, timeZone, filter: spaceFilter }),
    [weekStart, externalEvents, calendarAccounts, timeZone, spaceFilter],
  );
  const days = useMemo(() => buildWeek({ weekStart, filter: spaceFilter, tasks, extras, externalEvents: external }), [weekStart, spaceFilter, tasks, extras, external]);

  // T-09 : une règle posée depuis la fiche apparaît aussitôt sur la carte.
  const hasUnknownRule = tasks.some((task) => task.recurrenceId !== null && !recurrences.has(task.recurrenceId));
  useEffect(() => {
    if (hasUnknownRule) void syncRecurrences(tasks);
  }, [hasUnknownRule, tasks, syncRecurrences]);

  // Une routine validée ou annulée hors de cet écran (message « Annuler », Ctrl+Z) : les sept jours se relisent.
  useEffect(() => subscribeToTodaySources(container, () => void refreshExtras()), [container, refreshExtras]);

  // Bouton « + » (feuille « Nouvelle tâche », T-01) : date présélectionnée = aujourd'hui ; Ctrl+N de même.
  const [sheetOpen, setSheetOpen] = useState(false);
  const defaultOffsets = useDefaultReminderOffsets();
  const openCreate = useCallback((): void => setSheetOpen(true), []);
  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  // Déplacements (S-02) : glisser, clavier, question de portée des tâches récurrentes.
  const moves = useWeekMoves(days, weekStart, spaces, spaceFilter === 'all');

  // Balayage horizontal (iPhone) : gauche = semaine suivante, droite = précédente ; abandonné si une carte est tenue pour un glisser (S-02).
  const swipe = useSwipe({ onSwipe: (way) => shiftWeek(way === 'left' ? 1 : -1), disabled: moves.dragging || layout !== 'mobile' });

  // S-04 : « + Ajouter » d'un jour. Espace par défaut (T-01) : celui du filtre actif, sinon Pro ; jour passé permis.
  const addToDay = useCallback(
    async (date: LocalDate, title: string): Promise<boolean> => {
      if (!fallbackSpaceId) return false;
      const result = await addTask({ title, spaceId: resolveDefaultSpaceId(spaceFilter, fallbackSpaceId), date });
      return result.ok;
    },
    [addTask, fallbackSpaceId, spaceFilter],
  );

  // Squelette si le chargement dépasse 150 ms (A-09).
  const showSkeleton = useDelayedFlag(status === 'loading', 150);

  const pills = <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />;
  const openedTaskId = layout === 'pc' && detail?.type === 'task' ? detail.id : null;

  return (
    <div className="ct-week" data-layout={layout} data-sorting={moves.dragging ? 'true' : undefined}>
      <WeekHeader
        weekStart={weekStart}
        layout={layout}
        pills={pills}
        isCurrent={isCurrentWeek}
        onPrevious={() => shiftWeek(-1)}
        onNext={() => shiftWeek(1)}
        onCurrent={() => goToWeek(currentWeekStart, weekStart < currentWeekStart ? 'next' : 'previous')}
      />

      {actionErrorKey && <p className="ct-week__error" role="alert">{t(actionErrorKey)}</p>}
      {extrasFailed && <p className="ct-week__error" role="alert">{t('week.sourceError')}</p>}
      {status === 'error' && errorKey && <p className="ct-week__error" role="alert">{t(errorKey)}</p>}

      {status === 'error' ? null : (
        <div
          key={weekStart}
          className="ct-week__days"
          data-layout={layout}
          data-direction={direction ?? undefined}
          role="group"
          aria-label={t('week.daysLabel')}
          aria-busy={status === 'loading'}
          {...swipe}
        >
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
              routinesDisabled={day.date > today}
              openedTaskId={openedTaskId}
              skeleton={showSkeleton}
              dragProps={moves.dragProps}
              drop={moves.dropFor(day.date)}
              onFocusTask={moves.setFocusedTaskId}
              onOpenEvent={(id) => openDetail({ type: 'externalEvent', id })}
              onAddTask={addToDay}
              onToggleDone={(id) => void toggleDone(id)}
              onToggleRoutine={(id, date) => void toggleRoutine(id, date)}
              onOpen={(id) => openDetail({ type: 'task', id })}
            />
          ))}
        </div>
      )}
      {/* Changement de semaine annoncé aux lecteurs d'écran (S-03 critère 8) : « Semaine 40, 28 sept. – 4 oct. ». */}
      <div className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {t('week.announce', { number: isoWeekOf(weekStart).week, range: formatWeekRange(weekStart, addDays(weekStart, 6), 'short') })}
      </div>
      {/* Annonce aux lecteurs d'écran : chargement (A-09), réordonnancement (A-02) ; ni role="status" (réservé au bandeau « Annuler »). */}
      <div key={moves.announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {showSkeleton ? t('status.loading') : moves.announcement?.text}
      </div>

      <div className="ct-week__footer">
        <span className="ct-week__hint">{layout === 'pc' ? `${t('week.hintDrag')} · ${t('week.hintNavigate')}` : null}</span>
        <Fab onClick={openCreate} label={t('common.add')} />
      </div>

      {sheetOpen && (
        <TodayCreateSheet
          viewedDate={today}
          today={today}
          spaces={spaces}
          initialSpaceId={fallbackSpaceId ? resolveDefaultSpaceId(spaceFilter, fallbackSpaceId) : null}
          defaultOffsets={defaultOffsets}
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
              reminderOffsets: input.reminderOffsets,
            });
            return result.ok;
          }}
        />
      )}

      {moves.ghost}
      {moves.dialogs}
      <TaskDetail />
      <ExternalEventDetail />
    </div>
  );
}
