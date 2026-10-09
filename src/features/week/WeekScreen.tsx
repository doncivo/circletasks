import { useDefaultReminderOffsets } from '../reminders';
import type { CaptureInput } from '../capture';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import type { EventId, ExternalEventId, LocalDate } from '../../domain/types';
import { externalEventsByDay } from '../../domain/externalEvents';
import { addWeeks, buildWeek, isoWeekOf, weekDays, weekStartOf } from '../../domain/week';
import { detectTimeZone } from '../../platform';
import { t } from '../../i18n';
import { getFirstWeekday } from '../../i18n/formatPrefs';
import { sourceNames } from '../calendars/sourceNames';
import { addDays } from '../../domain/localDate';
import { formatWeekRange } from '../../i18n/format';
import { EmptyState, Fab, SwipeRowGroup, openNow, useDelayedFlag, useLayout, useSwipe } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useRowGestureFeedback } from '../app/rowGestureFeedback';
import { isModalOpen } from '../app/tabShortcuts';
import { WeekGoalBanners } from '../goals/WeekGoalBanners';
import { SomedayButton, SomedayPanel } from '../someday';
import { SpaceFilterBar, useAnnounceCreation, useDefaultSpaceId, useEffectiveProjectFilter } from '../spaces';
import { TaskDetail } from '../tasks';
import { scheduleOf } from '../tasks/TaskCreateSheet';
import { AddSheet } from '../events';
import { canToggleRoutines, subscribeToTodaySources } from '../today/todaySources';
import { ExternalEventDetail } from './ExternalEventDetail';
import { WeekDayView, type WeekGestures } from './WeekDayView';
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
  // QB-15 : filtre par projet (menu « Projet : tous »), global, seulement sous Pro ou Perso ; il ne garde que les tâches du projet.
  const projectFilter = useEffectiveProjectFilter();
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  // ES-02 : espace proposé à la création (filtre actif, sinon Pro) et message « Ajouté dans … » hors filtre.
  const defaultSpaceId = useDefaultSpaceId();
  const announceCreation = useAnnounceCreation();
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
  const sendToSomeday = useFeatureStore(weekStore, (s) => s.sendToSomeday);
  const refreshExtras = useFeatureStore(weekStore, (s) => s.refreshExtras);
  const syncRecurrences = useFeatureStore(weekStore, (s) => s.syncRecurrences);

  // Jour courant de l'app (T-06) : suit le passage de minuit.
  const today: LocalDate = appDay ?? todayLocal(container.clock);
  // Semaine affichée : celle de la route, ou la semaine courante ; premier jour réglé (P-03, lundi par défaut). Une semaine mémorisée
  // avant un changement de réglage est réalignée sur le nouveau premier jour.
  const firstWeekday = getFirstWeekday();
  const weekStart: LocalDate = weekStartOf(route.tab === 'week' && route.weekStart ? route.weekStart : today, firstWeekday);

  // S-06 : panneau « Un jour » à droite de la grille (PC) ; l'état ouvert / fermé vit dans la route, donc conservé pendant la session.
  const somedayOpen = layout === 'pc' && route.tab === 'week' && route.somedayPanel;
  const toggleSomeday = (): void => navigate({ tab: 'week', weekStart: route.tab === 'week' ? route.weekStart : null, somedayPanel: !somedayOpen });

  const currentWeekStart = weekStartOf(today, firstWeekday);
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

  const tasks = useMemo(() => selectWeekTasks(entities, weekStart, spaceFilter, projectFilter), [entities, weekStart, spaceFilter, projectFilter]);
  // Événements des agendas externes (S-05) : convertis dans le fuseau COURANT de l'appareil à chaque rendu utile, donc recalés
  // aussitôt qu'il change (T-11) ; filtrés par l'espace de leur agenda (ES-06).
  const timeZone = useAppStore((s) => s.timeZone) ?? detectTimeZone() ?? 'UTC';
  const external = useMemo(
    () =>
      projectFilter ? new Map() : externalEventsByDay({ days: weekDays(weekStart), events: externalEvents, accounts: calendarAccounts, timeZone, filter: spaceFilter, untitled: t('calendars.untitled'), sources: sourceNames() }),
    [weekStart, externalEvents, calendarAccounts, timeZone, spaceFilter, projectFilter],
  );
  const days = useMemo(() => buildWeek({ weekStart, filter: spaceFilter, tasks, extras: projectFilter ? new Map() : extras, externalEvents: external }), [weekStart, spaceFilter, tasks, extras, external, projectFilter]);

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
  const openCreate = useCallback((): void => openNow(() => setSheetOpen(true)), []);
  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  // Déplacements (S-02) : glisser, clavier, question de portée des tâches récurrentes.
  const moves = useWeekMoves(days, weekStart, spaces, spaceFilter === 'all', somedayOpen);

  // Balayage horizontal (iPhone) : gauche = semaine suivante, droite = précédente ; abandonné si une carte est tenue pour un glisser (S-02).
  const swipe = useSwipe({ onSwipe: (way) => shiftWeek(way === 'left' ? 1 : -1), disabled: moves.dragging || layout !== 'mobile' });

  // A-07 : gestes de ligne sur iPhone, mêmes cas d'usage que la case, Ctrl+D et le glisser ; l'appui long reste le glisser (Q16).
  const rowFeedback = useRowGestureFeedback();
  const gestures: WeekGestures | null =
    layout === 'mobile'
      ? {
          api: { complete: toggleDone, postpone: (task) => moves.requestPostpone(task.id), sendToSomeday, requestDelete: moves.requestDelete },
          toggleRoutine,
          feedback: rowFeedback,
          disabled: moves.dragging,
        }
      : null;

  // S-04 : « + Ajouter » d'un jour. Espace par défaut (T-01) : celui du filtre actif, sinon Pro ; jour passé permis.
  const addToDay = useCallback(
    async (date: LocalDate, capture: CaptureInput): Promise<boolean> => {
      const spaceId = capture.spaceId ?? defaultSpaceId;
      if (!spaceId) return false;
      // Q-02 : la date écrite dans le texte l'emporte sur le jour de la colonne ; une heure écrite reçoit les rappels par défaut (QB-08).
      const result = await addTask({
        title: capture.title,
        spaceId,
        date: capture.dateWritten && capture.date ? capture.date : date,
        projectId: capture.projectId,
        ...(capture.time !== null ? { time: capture.time, reminderOffsets: defaultOffsets } : {}),
      });
      if (result.ok) announceCreation(spaceId);
      return result.ok;
    },
    [addTask, announceCreation, defaultSpaceId, defaultOffsets],
  );

  // Squelette si le chargement dépasse 150 ms (A-09).
  const showSkeleton = useDelayedFlag(status === 'loading', 150);

  const weekSpaceName = spaceFilter === 'all' ? null : (spaces.find((space) => space.id === spaceFilter)?.name ?? null);
  const pills = <SpaceFilterBar />;
  const openedTaskId = layout === 'pc' && detail?.type === 'task' ? detail.id : null;

  const content = (
    <div className="ct-week" data-layout={layout} data-sorting={moves.dragging ? 'true' : undefined}>
      <WeekHeader
        weekStart={weekStart}
        layout={layout}
        pills={pills}
        isCurrent={isCurrentWeek}
        onPrevious={() => shiftWeek(-1)}
        onNext={() => shiftWeek(1)}
        onCurrent={() => goToWeek(currentWeekStart, weekStart < currentWeekStart ? 'next' : 'previous')}
        shortRange={somedayOpen}
        {...(layout === 'pc' ? { somedayToggle: <SomedayButton onToggle={toggleSomeday} pressed={somedayOpen} /> } : {})}
      />

      {actionErrorKey && <p className="ct-week__error" role="alert">{t(actionErrorKey)}</p>}
      {extrasFailed && <p className="ct-week__error" role="alert">{t('week.sourceError')}</p>}
      {status === 'error' && errorKey && <p className="ct-week__error" role="alert">{t(errorKey)}</p>}

      {/* OB-02 critère 6 : bandeau de l'objectif épinglé de la semaine affichée (PC). */}
      {layout === 'pc' && <WeekGoalBanners weekStart={weekStart} hidden={projectFilter !== null} />}

      {/* P-06 : semaine entièrement vide ; un jour vide seul est déjà couvert par « + Ajouter » (S-04). */}
      {status === 'ready' && days.every((day) => day.list.isEmpty) && (
        <EmptyState
          className="ct-week__empty"
          screen="week"
          title={weekSpaceName ? t('empty.weekTitleSpace', { space: weekSpaceName }) : t('empty.weekTitle')}
          action={{ label: t('empty.addTask'), onClick: openCreate }}
        />
      )}

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
          <SwipeRowGroup>
          {days.map((day) => (
            <WeekDayView
              key={day.date}
              day={day}
              layout={layout}
              isToday={day.date === today}
              today={today}
              spaces={spaces}
              showSpace={spaceFilter === 'all'}
              recurrences={recurrences}
              routinesCheckable={canToggleRoutines()}
              routinesDisabled={day.date > today}
              openedTaskId={openedTaskId}
              skeleton={showSkeleton}
              dragProps={moves.dragProps}
              gestures={gestures}
              drop={moves.dropFor(day.date)}
              onFocusTask={moves.setFocusedTaskId}
              onOpenEvent={(entry) => openDetail(entry.calendarName !== null ? { type: 'externalEvent', id: entry.id as ExternalEventId } : { type: 'event', id: entry.id as EventId })}
              onOpenChecklist={(id) => navigate({ tab: 'checklists', checklistId: id })}
              onAddTask={addToDay}
              onToggleDone={(id) => void toggleDone(id)}
              onToggleRoutine={(id, date) => void toggleRoutine(id, date)}
              onOpen={(id) => openDetail({ type: 'task', id })}
            />
          ))}
          </SwipeRowGroup>
        </div>
      )}
      {/* Changement de semaine annoncé aux lecteurs d'écran (S-03 critère 8) : « Semaine 40, 28 sept. – 4 oct. ». */}
      <div className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {t('week.announce', { number: isoWeekOf(addDays(weekStart, 3)).week, range: formatWeekRange(weekStart, addDays(weekStart, 6), 'short') })}
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
        <AddSheet
          initialSegment="task"
          date={today}
          onClose={() => setSheetOpen(false)}
          taskSheet={{
            viewedDate: today,
            initialProjectId: projectFilter,
            defaultOffsets,
            onCreate: async (input) => {
              const schedule = scheduleOf(input.choice);
              const result = await addTask({
                title: input.title,
                spaceId: input.spaceId,
                projectId: input.projectId,
                date: schedule.date ?? today,
                ...(schedule.someday ? { someday: true } : {}),
                ...(schedule.time !== undefined ? { time: schedule.time } : {}),
                recurrence: input.recurrence,
                icon: input.icon,
                reminderOffsets: input.reminderOffsets,
                goalId: input.goalId,
                taskId: input.taskId,
              });
              if (result.ok) announceCreation(input.spaceId);
              return result.ok;
            },
          }}
        />
      )}

      {moves.ghost}
      {moves.dialogs}
      <TaskDetail />
      <ExternalEventDetail />
    </div>
  );
  if (layout !== 'pc') return content;
  // PC : la grille se réduit pour laisser place au panneau « Un jour » (S-06), sans masquer de jour.
  return (
    <div className="ct-week-shell">
      {content}
      {somedayOpen && <SomedayPanel onClose={toggleSomeday} zone={moves.somedayZone} />}
    </div>
  );
}
