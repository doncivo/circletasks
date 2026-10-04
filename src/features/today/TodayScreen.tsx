import { useDefaultReminderOffsets } from '../reminders';
import { ChartColumn, Target } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import type { DateChoice } from '../../domain/dateInput';
import { addDays } from '../../domain/localDate';
import { matchesSpaceFilter } from '../../domain/spaceRules';
import { buildTodayList } from '../../domain/todayList';
import type { EventId, LocalDate, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { formatWeekdayName } from '../../i18n/format';
import { CompactToggle, EditModeSwitch, Fab, Icon, Kbd, useDelayedFlag, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useQuickAddStore } from '../app/quickAdd';
import { SomedayButton } from '../someday';
import { SpaceFilterBar, useAnnounceCreation, useDefaultSpaceId, useEffectiveProjectFilter } from '../spaces';
import { TaskDetail } from '../tasks';
import { TodayAddRow } from './TodayCreate';
import { scheduleOf } from '../tasks/TaskCreateSheet';
import { AddSheet } from '../events';
import { TodayHeader } from './TodayHeader';
import { TodayListView } from './TodayListView';
import { GoalReviewCards } from '../goals/GoalReviewCards';
import { TodayChecklists, TodayEmpty, TodayEventBands, TodayGoalCard } from './TodayParts';
import { useTodayRowActions } from './TodayRowActions';
import { canToggleRoutines, subscribeToTodaySources } from './todaySources';
import { selectTodayTasks, todayStore } from './todayStore';
import { TodaySelectionBar, TodaySelectionDialogs, useTodayEditMode } from './useTodayEditMode';
import { useTodayReorder } from './useTodayReorder';
import './TodayScreen.css';

/**
 * Écran Aujourd'hui (A-01) : en-tête de date, pastilles d'espace, objectif et événements fournis par leurs modules, liste mêlée
 * routines + tâches, terminés, checklists, création rapide, mode édition (A-05), vue compacte (A-06) et fiche détail (A-08).
 * Rien n'est simulé pour les modules absents (`todaySources`).
 */
export function TodayScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  // QB-15 : filtre par projet (menu « Projet : tous »), global, seulement sous Pro ou Perso ; il ne garde que les tâches du projet.
  const projectFilter = useEffectiveProjectFilter();
  // Espaces (ES-01) : lus une fois dans useAppStore (App.tsx, via SpaceRepository), jamais importés depuis db/seed.
  const spaces = useAppStore((s) => s.spaces);
  // ES-02 : espace proposé à la création (filtre actif, sinon Pro) et message « Ajouté dans … » hors filtre.
  const defaultSpaceId = useDefaultSpaceId();
  const announceCreation = useAnnounceCreation();

  const taskIds = useFeatureStore(todayStore, (s) => s.taskIds);
  const entities = useTaskEntities();
  const recurrences = useFeatureStore(todayStore, (s) => s.recurrences);
  const viewDate = useFeatureStore(todayStore, (s) => s.date);
  const viewFilter = useFeatureStore(todayStore, (s) => s.filter);
  const extras = useFeatureStore(todayStore, (s) => s.extras);
  const extrasFailed = useFeatureStore(todayStore, (s) => s.extrasFailed);
  const hideRoutines = useFeatureStore(todayStore, (s) => s.hideRoutines);
  const compact = useFeatureStore(todayStore, (s) => s.compact);
  const setCompact = useFeatureStore(todayStore, (s) => s.setCompact);
  const actionErrorKey = useFeatureStore(todayStore, (s) => s.actionErrorKey);
  const status = useFeatureStore(todayStore, (s) => s.status);
  const errorKey = useFeatureStore(todayStore, (s) => s.errorKey);
  const load = useFeatureStore(todayStore, (s) => s.load);
  const addTask = useFeatureStore(todayStore, (s) => s.addTask);
  const toggleDone = useFeatureStore(todayStore, (s) => s.toggleDone);
  const toggleRoutine = useFeatureStore(todayStore, (s) => s.toggleRoutine);
  const refreshExtras = useFeatureStore(todayStore, (s) => s.refreshExtras);
  const syncRecurrences = useFeatureStore(todayStore, (s) => s.syncRecurrences);
  const openDetail = useNavigationStore((s) => s.openDetail);
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const detail = useNavigationStore((s) => s.detail);
  const navigate = useNavigationStore((s) => s.navigate);
  const route = useNavigationStore((s) => s.route);

  // Jour courant de l'app (T-06) : suit le passage de minuit (rollover) ; horloge avant le premier contrôle.
  const appDay = useAppStore((s) => s.day);
  const carryOverFailed = useAppStore((s) => s.carryOverFailed);
  const recurrenceFailed = useAppStore((s) => s.recurrenceFailed);
  const today = appDay ?? todayLocal(container.clock);
  // Jour affiché : le jour courant, ou celui choisi par les flèches « Jour précédent / suivant » (PC, Q10).
  const viewedDate: LocalDate = route.tab === 'tasks' && route.screen === 'today' && route.date ? route.date : today;
  const goToDay = (date: LocalDate): void => navigate(date === today ? { tab: 'tasks', screen: 'today' } : { tab: 'tasks', screen: 'today', date });

  // Date et espace revérifiés à chaque rendu (selectTasks) : une tâche reportée quitte la liste aussitôt (T-05).
  const dayTasks = useMemo(() => selectTodayTasks(taskIds, entities, { date: viewDate, filter: viewFilter, projectId: projectFilter }), [taskIds, entities, viewDate, viewFilter, projectFilter]);
  // Assemblage de la liste du jour (domaine) : objectif, événements, routines et tâches mêlées, terminés, checklists.
  const list = useMemo(
    () =>
      buildTodayList({
        date: viewDate ?? viewedDate,
        filter: viewFilter,
        tasks: dayTasks,
        // Un filtre projet ne montre que des tâches : routines, événements, checklists et objectif n'ont pas de projet.
        routines: projectFilter ? [] : extras.routines,
        events: projectFilter ? [] : extras.events,
        checklists: projectFilter ? [] : extras.checklists,
        goals: projectFilter ? [] : extras.goals,
        hideRoutines,
      }),
    [dayTasks, extras, hideRoutines, projectFilter, viewDate, viewedDate, viewFilter],
  );

  const edit = useTodayEditMode(list);
  const rowActions = useTodayRowActions(edit);
  const reorder = useTodayReorder(list, rowActions.focusedTaskId);

  // T-09 : une règle posée depuis la fiche apparaît aussitôt sur la ligne (lecture des règles inconnues).
  const hasUnknownRule = dayTasks.some((task) => task.recurrenceId !== null && !recurrences.has(task.recurrenceId));
  useEffect(() => {
    if (hasUnknownRule) void syncRecurrences();
  }, [hasUnknownRule, syncRecurrences]);

  // Une routine validée ou annulée hors de cet écran (message « Annuler », Ctrl+Z) : les éléments du jour se relisent.
  useEffect(() => subscribeToTodaySources(container, () => void refreshExtras()), [container, refreshExtras]);

  useEffect(() => {
    void load(viewedDate, spaceFilter);
    // Recharge au changement de filtre, de jour affiché (flèches PC) et au passage de minuit (T-06, `today` suit `appDay`).
    // `load` ne rejette jamais.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceFilter, viewedDate]);

  // T-12 : une tâche du jour affiché publiée ailleurs (copie créée depuis la fiche, dupliquée vers aujourd'hui)
  // rejoint la liste par un rechargement ; chaque identifiant n'est tenté qu'une fois (pas de boucle si la base ne la renvoie pas).
  const adoptTried = useRef(new Set<TaskId>());
  useEffect(() => {
    if (viewDate === null || status !== 'ready') return;
    const known = new Set(taskIds);
    let missing = false;
    for (const task of entities.values()) {
      if (task.date !== viewDate || task.someday || known.has(task.id) || adoptTried.current.has(task.id)) continue;
      if (!matchesSpaceFilter(task, viewFilter)) continue;
      adoptTried.current.add(task.id);
      missing = true;
    }
    if (missing) void load(viewDate, viewFilter);
  }, [entities, taskIds, viewDate, viewFilter, status, load]);

  // Création : saisie en ligne (PC) ou feuille « Nouvelle tâche » (iPhone).
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const defaultOffsets = useDefaultReminderOffsets();
  const openCreate = useCallback((): void => {
    if (layout === 'pc') inlineInputRef.current?.focus();
    else setSheetOpen(true);
  }, [layout]);
  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  // D-01 : « Ajout rapide » de la zone de notification = même comportement que Ctrl+N. Abonnement au store plutôt qu'état lu au
  // rendu : une demande faite avant le montage est prise au premier passage de la minuterie, une seule fois.
  useEffect(() => {
    const run = (): void => {
      if (useQuickAddStore.getState().consume()) openCreate();
    };
    const initial = window.setTimeout(run, 0);
    const unsubscribe = useQuickAddStore.subscribe(run);
    return () => {
      window.clearTimeout(initial);
      unsubscribe();
    };
  }, [openCreate]);

  async function submitInline(title: string, choice: DateChoice | null): Promise<boolean> {
    if (!defaultSpaceId) return false;
    const result = await addTask(title, defaultSpaceId, scheduleOf(choice), undefined, projectFilter);
    if (result.ok) announceCreation(defaultSpaceId);
    return result.ok;
  }

  // Squelette si le chargement dépasse 150 ms (A-09) ; la liste est `aria-busy` pendant le chargement.
  const showSkeleton = useDelayedFlag(status === 'loading', 150);

  // ES-03 critère 6 : sous Pro ou Perso, l'écran vide nomme l'espace (« Aucune tâche Pro aujourd'hui »).
  const filteredSpaceName = spaceFilter === 'all' ? null : (spaces.find((space) => space.id === spaceFilter)?.name ?? null);
  const weekdayName = formatWeekdayName(viewedDate);
  const emptyMessage =
    filteredSpaceName !== null
      ? viewedDate === today
        ? t('spaces.emptyToday', { space: filteredSpaceName })
        : t('spaces.emptyDay', { space: filteredSpaceName, weekday: weekdayName })
      : viewedDate === today
        ? t('tasks.emptyToday')
        : t('today.emptyDay', { weekday: weekdayName });

  // Icône cible et encadrés d'objectif (OB-01, OB-02) : ouvrent l'écran Objectif (panneau à droite sur PC, écran plein sur iPhone).
  const openGoals = (): void => {
    closeDetail();
    navigate({ tab: 'tasks', screen: 'goals' });
  };
  const pills = <SpaceFilterBar />;
  const goalButton = (
    <button type="button" className="ct-today__iconButton" aria-label={t('goals.open')} onClick={openGoals}>
      <Icon icon={Target} size={layout === 'pc' ? 24 : 26} />
    </button>
  );
  const reportButton = (
    <button type="button" className="ct-today__iconButton" aria-label={t('report.openFromToday')} onClick={() => navigate({ tab: 'tasks', screen: 'report' })}>
      <Icon icon={ChartColumn} size={layout === 'pc' ? 24 : 26} />
    </button>
  );

  return (
    <div className="ct-today-shell" data-layout={layout}>
      <div className="ct-today" data-layout={layout}>
        {/* PC (PC-Aujourdhui.html) : pastilles à gauche de la rangée du haut, icônes à droite ; iPhone (Main.html) : icônes en haut,
            pastilles sous le filet. L'icône « Un jour » (SD-01) est la première des icônes ; la recherche arrive avec RC-01. */}
        <div className="ct-today__quickIcons" data-layout={layout}>
          {layout === 'pc' && pills}
          <span className="ct-today__quickSpacer" />
          <SomedayButton />
          {goalButton}
          {reportButton}
        </div>

        <TodayHeader
          date={viewedDate}
          today={today}
          layout={layout}
          actions={<CompactToggle active={compact} onChange={(value) => void setCompact(value)} label={t('today.compactView')} />}
          {...(layout === 'pc' ? { onPreviousDay: () => goToDay(addDays(viewedDate, -1)), onNextDay: () => goToDay(addDays(viewedDate, 1)) } : {})}
        />

        {layout === 'mobile' && pills}

        {actionErrorKey && <p className="ct-today__error" role="alert">{t(actionErrorKey)}</p>}
        {carryOverFailed && <p className="ct-today__error" role="alert">{t('tasks.carryOverError')}</p>}
        {recurrenceFailed && <p className="ct-today__error" role="alert">{t('tasks.recurrenceError')}</p>}
        {extrasFailed && <p className="ct-today__error" role="alert">{t('today.sourceError')}</p>}
        {status === 'error' && errorKey && <p className="ct-today__error" role="alert">{t(errorKey)}</p>}

        {status === 'error' ? null : (
          <>
            {/* OB-05 : propositions « Reconduire / Clore » des objectifs non atteints, en tête de liste. */}
            <GoalReviewCards hidden={projectFilter !== null} />
            {(list.goals.length > 0 || list.events.length > 0) && (
              <div className="ct-today-banners" data-layout={layout}>
                {list.goals.map((entry) => (
                  <TodayGoalCard key={entry.goal.id} entry={entry} compact={compact} onOpen={openGoals} />
                ))}
                <TodayEventBands events={list.events} compact={compact} onOpen={(entry) => entry.calendarName === null && openDetail({ type: 'event', id: entry.id as EventId })} />
              </div>
            )}
            {status === 'ready' && list.isEmpty && (
              <TodayEmpty message={emptyMessage} />
            )}
            <TodayListView
              list={list}
              layout={layout}
              compact={compact}
              loading={status === 'loading'}
              showSkeleton={showSkeleton}
              spaces={spaces}
              spaceFilter={spaceFilter}
              recurrences={recurrences}
              routinesCheckable={canToggleRoutines()}
              routinesDisabled={viewedDate > today}
              openedTaskId={layout === 'pc' && detail?.type === 'task' ? detail.id : null}
              edit={edit}
              rowActions={rowActions}
              reorder={reorder}
              onToggleDone={(id) => void toggleDone(id)}
              onToggleRoutine={(id) => void toggleRoutine(id)}
              onOpen={(id) => openDetail({ type: 'task', id })}
            />
            <TodayChecklists
              items={list.checklists}
              spaces={spaces}
              showSpace={spaceFilter === 'all'}
              onOpen={(id) => navigate({ tab: 'checklists', checklistId: id })}
            />
            {/* Annonce aux lecteurs d'écran : déplacement (A-02), chargement (A-09) ; ni role="status" (réservé au bandeau « Annuler »). */}
            <div key={reorder.announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
              {showSkeleton ? t('status.loading') : reorder.announcement?.text}
            </div>
          </>
        )}

        <TodaySelectionBar edit={edit} />

        <TodayAddRow layout={layout} today={today} inputRef={inlineInputRef} onSubmit={submitInline} />

        <div className="ct-today__bottomRow">
          <EditModeSwitch active={edit.editMode} onChange={edit.setEditMode} label={t('today.editMode')} />
          {layout === 'pc' && (
            <span className="ct-today__hint">
              <Kbd keys="Ctrl+N" separator=" " /> {t('today.hintNewTask')}
            </span>
          )}
          <Fab onClick={openCreate} label={t('common.add')} />
        </div>

        {sheetOpen && (
          <AddSheet
            initialSegment="task"
            date={viewedDate}
            onClose={() => setSheetOpen(false)}
            taskSheet={{
              viewedDate,
              initialProjectId: projectFilter,
              defaultOffsets,
              onCreate: async (input) => {
                const result = await addTask(input.title, input.spaceId, { ...scheduleOf(input.choice), recurrence: input.recurrence, reminderOffsets: input.reminderOffsets, goalId: input.goalId }, input.icon, input.projectId);
                if (result.ok) announceCreation(input.spaceId);
                return result.ok;
              },
            }}
          />
        )}
      </div>

      <TaskDetail />
      {rowActions.dialogs}
      <TodaySelectionDialogs edit={edit} spaces={spaces} />
    </div>
  );
}
