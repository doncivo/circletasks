import { useDefaultReminderOffsets } from '../reminders';
import { AlignJustify, ChartColumn, EllipsisVertical, Pencil, Plus, Target } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nowLocalTime, todayLocal } from '../../domain/clock';
import { buildTodayAgenda } from '../../domain/todayAgenda';
import type { CaptureInput } from '../capture';
import type { DateChoice } from '../../domain/dateInput';
import { addDays } from '../../domain/localDate';
import { matchesSpaceFilter } from '../../domain/spaceRules';
import { buildTodayList } from '../../domain/todayList';
import type { LocalDate, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { formatWeekdayName } from '../../i18n/format';
import { Icon, openNow, useDelayedFlag, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { isListFocus, registerListNavigation } from '../app/listKeyboard';
import { useQuickAddStore } from '../app/quickAdd';
import { useRowGestureFeedback } from '../app/rowGestureFeedback';
import { SearchButton } from '../search';
import { SomedayButton, useSomedayTasks } from '../someday';
import { SpaceFilterBar, useAnnounceCreation, useDefaultSpaceId, useEffectiveProjectFilter } from '../spaces';
import { lazyScreen, TaskDetail } from '../app/lazyScreens';
import { TodayAddRow } from './TodayCreate';
import type { TodayMoreMenuProps } from './TodayMoreMenu';
import type { TodaySideProps } from './TodaySide';
import { scheduleOf } from '../tasks/TaskCreateSheet';
import { AddSheet } from '../events';
import { TodayHeader } from './TodayHeader';
import { TodayListView, type TodayGestures } from './TodayListView';
import { GoalReviewCards } from '../goals/GoalReviewCards';
import { TodayChecklists, TodayEmpty, TodayGoalLine } from './TodayParts';
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
 *
 * iPhone (UI-REFONTE-02, Jour.html) : l'agenda du jour, Rechercher et « Plus d’options » à droite de la date, rangée d'ajout en bas.
 * PC (UI-REFONTE-08, PC-Jour.html) : barre fixe nommée (pastilles, Rechercher, Objectif, Rapport, Un jour, Ajouter, Édition, Compacte),
 * colonne du jour bornée à 660 px avec le même agenda, seconde colonne « Demain · Cette semaine · Raccourcis » (bloc à la demande).
 */
/** Liste du jour (D-04) : cible de ↑ / ↓ et d'Entrée. */
const todayListRoot = (): HTMLElement | null => document.querySelector<HTMLElement>('.ct-today__list');

/** Menu « Plus d’options » de l'iPhone (UI-REFONTE-02) : feuille et catalogue chargés à la demande, hors du départ. */
const LazyTodayMoreMenu = lazyScreen<TodayMoreMenuProps>(() => import('./TodayMoreMenu').then((m) => ({ default: m.TodayMoreMenu })), undefined, { onDemand: true });
/** Seconde colonne du PC (UI-REFONTE-08) : bloc et catalogue chargés à la demande, hors du départ. */
const LazyTodaySide = lazyScreen<TodaySideProps>(() => import('./TodaySide').then((m) => ({ default: m.TodaySide })), undefined, { onDemand: true });

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
  const sendToSomeday = useFeatureStore(todayStore, (s) => s.sendToSomeday);
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

  // UI-REFONTE-02 (iPhone) puis UI-REFONTE-08 (PC) : l'agenda du jour sur la colonne des heures pour les deux mises en page ; la ligne
  // « maintenant » suit l'horloge à la minute, le jour courant seulement.
  const agendaMode = true;
  const [now, setNow] = useState(() => nowLocalTime(container.clock));
  useEffect(() => {
    if (!agendaMode) return undefined;
    const tick = (): void => setNow(nowLocalTime(container.clock));
    tick();
    const id = window.setInterval(tick, 60_000);
    return () => window.clearInterval(id);
  }, [agendaMode, container, appDay]);
  const agendaLines = useMemo(() => (agendaMode ? buildTodayAgenda(list, viewedDate === today ? now : null) : null), [agendaMode, list, viewedDate, today, now]);
  const [moreOpen, setMoreOpen] = useState(false);

  const edit = useTodayEditMode(list);
  const rowActions = useTodayRowActions(edit);
  const reorder = useTodayReorder(list, rowActions.focusedTaskId);
  // A-07 : gestes de ligne sur iPhone seulement ; mêmes cas d'usage que la case, Ctrl+D et Suppr (annulation 5 s comprise).
  const rowFeedback = useRowGestureFeedback();
  const gestures: TodayGestures | null =
    layout === 'mobile'
      ? {
          api: { complete: toggleDone, postpone: rowActions.requestPostpone, sendToSomeday, requestDelete: rowActions.requestDelete },
          toggleRoutine,
          feedback: rowFeedback,
        }
      : null;

  // D-04 : ↑ / ↓ passent à la ligne précédente / suivante ; Entrée ouvre le détail de la ligne sélectionnée (si le focus est dans la liste).
  useEffect(
    () =>
      registerListNavigation(container.shortcuts, {
        root: todayListRoot,
        itemSelector: '[role="listitem"]',
        focusSelector: '.ct-list-row__title',
      }),
    [container],
  );
  const selectedTaskId = rowActions.focusedTaskId;
  useEffect(() => {
    if (!selectedTaskId) return undefined;
    return container.shortcuts.register('list.open', (): boolean => {
      if (!isListFocus(todayListRoot())) return false;
      openDetail({ type: 'task', id: selectedTaskId });
      return true;
    });
  }, [container, selectedTaskId, openDetail]);

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

  // Création : saisie en ligne (PC) ou feuille « Nouvelle tâche » (iPhone) ; sur PC, « Ajouter » de la barre ouvre aussi la feuille.
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const defaultOffsets = useDefaultReminderOffsets();
  const { count: somedayCount } = useSomedayTasks();
  const openCreate = useCallback((): void => {
    if (layout === 'pc') inlineInputRef.current?.focus();
    else openNow(() => setSheetOpen(true));
  }, [layout]);
  const openSheet = useCallback((): void => openNow(() => setSheetOpen(true)), []);
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

  async function submitInline(capture: CaptureInput, choice: DateChoice | null): Promise<boolean> {
    const spaceId = capture.spaceId ?? defaultSpaceId;
    if (!spaceId) return false;
    // Date réglée à la main (champ Date PC) d'abord, sinon celle écrite dans le texte (Q-02), sinon le jour affiché (une heure seule ne change pas le jour).
    const schedule = choice !== null ? scheduleOf(choice) : capture.dateWritten && capture.date !== null
        ? { date: capture.date, ...(capture.time !== null ? { time: capture.time } : {}) }
        : capture.time !== null
          ? { time: capture.time }
          : {};
    const result = await addTask(capture.title, spaceId, schedule, undefined, capture.projectId ?? undefined);
    if (result.ok) announceCreation(spaceId);
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

  // Objectif (OB-01, OB-02) : ouvre l'écran Objectif (panneau à droite sur PC, écran plein sur iPhone).
  const openGoals = (): void => {
    closeDetail();
    navigate({ tab: 'tasks', screen: 'goals' });
  };
  const openSomeday = (): void => {
    closeDetail();
    navigate({ tab: 'tasks', screen: 'someday' });
  };
  const openReport = (): void => navigate({ tab: 'tasks', screen: 'report' });
  const openShortcuts = (): void => useNavigationStore.getState().openOverlay({ kind: 'shortcutsHelp' });
  const pills = <SpaceFilterBar />;

  /* UI-REFONTE-08 (PC-Jour.html) : barre fixe ; les icônes portent leur nom ; « Ajouter » remplace le bouton flottant ; les deux
     bascules A-05 / A-06 y sont nommées (libellés accessibles inchangés : « Mode édition », « Vue compacte »). */
  const topbar = (
    <div className="ct-today__topbar">
      {pills}
      <SearchButton />
      <span className="ct-today__topbarSpacer" />
      <button type="button" className="ct-today__barButton" aria-label={t('goals.open')} onClick={openGoals}>
        <Icon icon={Target} size={18} />
        <span>{t('today.barGoals')}</span>
      </button>
      <button type="button" className="ct-today__barButton" aria-label={t('report.openFromToday')} onClick={openReport}>
        <Icon icon={ChartColumn} size={18} />
        <span>{t('today.barReport')}</span>
      </button>
      <SomedayButton showLabel />
      <button type="button" className="ct-today__barButton" aria-label={t('common.add')} onClick={openSheet}>
        <Icon icon={Plus} size={18} />
        <span>{t('common.add')}</span>
      </button>
      <button type="button" className="ct-today__barButton" aria-label={t('today.editMode')} aria-pressed={edit.editMode} onClick={() => edit.setEditMode(!edit.editMode)}>
        <Icon icon={Pencil} size={18} />
        <span>{t('today.barEdit')}</span>
      </button>
      <button type="button" className="ct-today__barButton" aria-label={t('today.compactView')} aria-pressed={compact} onClick={() => void setCompact(!compact)}>
        <Icon icon={AlignJustify} size={18} />
        <span>{t('today.barCompact')}</span>
      </button>
    </div>
  );

  const dayColumn = (
    <>
      <TodayHeader
        date={viewedDate}
        today={today}
        layout={layout}
        hideBadge={agendaMode}
        hideRule={layout === 'pc'}
        actions={
          layout === 'mobile' ? (
            <>
              <SearchButton iconClassName="ct-today__iconButton" />
              <button type="button" className="ct-today__iconButton" aria-label={t('today.moreOptions')} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => openNow(() => setMoreOpen(true))}>
                <Icon icon={EllipsisVertical} size={26} />
              </button>
            </>
          ) : null
        }
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
          {/* Objectif en une ligne (UI-REFONTE-02, UI-REFONTE-08) ; les événements sont des lignes de l'agenda. */}
          {list.goals.map((entry) => (
            <TodayGoalLine key={entry.goal.id} entry={entry} onOpen={openGoals} />
          ))}
          {status === 'ready' && list.isEmpty && <TodayEmpty message={emptyMessage} somedayCount={somedayCount} onOpenSomeday={openSomeday} onAdd={openCreate} />}
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
            gestures={gestures}
            agenda={agendaLines ? { lines: agendaLines, date: viewDate ?? viewedDate, today, onOpenEvent: (id) => openDetail({ type: 'event', id }) } : null}
          />
          <TodayChecklists items={list.checklists} spaces={spaces} showSpace={spaceFilter === 'all'} onOpen={(id) => navigate({ tab: 'checklists', checklistId: id })} />
          {/* Annonce aux lecteurs d'écran : déplacement (A-02), chargement (A-09) ; ni role="status" (réservé au bandeau « Annuler »). */}
          <div key={reorder.announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true" data-testid="reorder-announcer">
            {showSkeleton ? t('status.loading') : reorder.announcement?.text}
          </div>
        </>
      )}

      <TodaySelectionBar edit={edit} />

      {layout === 'mobile' ? (
        /* Jour.html : champ « Ajouter une tâche », Scanner et « + » sur une seule rangée, au-dessus de la zone de sécurité ; la bascule édition est dans le menu. */
        <div className="ct-agenda__add">
          <TodayAddRow layout={layout} today={today} inputRef={inlineInputRef} onSubmit={submitInline} scanInline />
          <button type="button" className="ct-fab" aria-label={t('common.add')} onClick={openSheet}>
            <Icon icon={Plus} size={28} color="var(--ct-color-accent-on)" strokeWidth={2.2} />
          </button>
        </div>
      ) : (
        /* PC-Jour.html : champ d'ajout avec « Date » (T-14) et « Scanner » (Q-04) en bas de la colonne du jour ; plus de bouton flottant. */
        <TodayAddRow layout={layout} today={today} inputRef={inlineInputRef} onSubmit={submitInline} />
      )}

      {moreOpen && (
        <LazyTodayMoreMenu
          somedayCount={somedayCount}
          compact={compact}
          editMode={edit.editMode}
          onSomeday={openSomeday}
          onGoals={openGoals}
          onReport={openReport}
          onCompact={(value) => void setCompact(value)}
          onEditMode={edit.setEditMode}
          onClose={() => setMoreOpen(false)}
        />
      )}
    </>
  );

  return (
    <div className="ct-today-shell" data-layout={layout}>
      <div className="ct-today" data-layout={layout}>
        {layout === 'pc' ? (
          <>
            {topbar}
            <div className="ct-today__columns">
              <div className="ct-today__dayColumn">{dayColumn}</div>
              <LazyTodaySide today={today} filter={spaceFilter} projectFilter={projectFilter} refreshKey={entities} onOpenShortcuts={openShortcuts} />
            </div>
          </>
        ) : (
          dayColumn
        )}

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
                const result = await addTask(input.title, input.spaceId, { ...scheduleOf(input.choice), recurrence: input.recurrence, reminderOffsets: input.reminderOffsets, goalId: input.goalId, taskId: input.taskId }, input.icon, input.projectId);
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
