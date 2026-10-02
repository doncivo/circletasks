import { ChartColumn, X } from 'lucide-react';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { addDays } from '../../domain/localDate';
import type { RecurrenceFields } from '../../domain/model';
import type { IconRef } from '../../domain/model/icon';
import { buildTodayList, rowTime, type TodayRow } from '../../domain/todayList';
import { TASK_TITLE_MAX_LENGTH, resolveDefaultSpaceId, validateTaskTitle } from '../../domain/taskRules';
import type { DateChoice } from '../../domain/dateInput';
import type { LocalDate, RoutineId, SpaceId, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { formatWeekdayName } from '../../i18n/format';
import { Button, ChoiceDialog, Checkbox, DatePicker, Fab, Icon, IconChooser, IconView, ListRow, RecurrencePicker, Sheet, SpacePills, TextField, resolveIconRefColor, useLayout, useSortable } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useQuickAddStore } from '../app/quickAdd';
import { DuplicatePrompt, TaskDetail } from '../tasks';
import { DeleteTaskConfirm } from '../tasks/DeleteTaskConfirm';
import { taskSubtitle } from '../tasks/taskLine';
import { TodayHeader } from './TodayHeader';
import { TodayChecklists, TodayEmpty, TodayEventBands, TodayGoalCard } from './TodayParts';
import { canToggleRoutines } from './todaySources';
import type { NewTaskSchedule } from './todayStore';
import { selectTodayTasks, todayStore } from './todayStore';
import './TodayScreen.css';

/**
 * Planification choisie dans le sélecteur de date (T-14) : aucun choix = jour affiché ; « Un jour » = tâche
 * sans date ; sinon date et heure optionnelle.
 */
function scheduleOf(choice: DateChoice | null): NewTaskSchedule {
  // `exactOptionalPropertyTypes` (tsconfig) : on n'inclut `date` / `time` que lorsqu'une valeur est choisie.
  if (choice === null) return {};
  if (choice.date === null) return { someday: true };
  return { date: choice.date, ...(choice.time !== null ? { time: choice.time } : {}) };
}

/**
 * Écran Aujourd'hui (A-01), version minimale livrée par T-01 : en-tête de date,
 * pastilles d'espace, liste des tâches du jour et création rapide. T-03 ajoute le
 * choix d'icône / emoji dans la feuille « Nouvelle tâche » (iPhone), l'icône de fin
 * de ligne et l'ouverture de la fiche détail (zones icône et note, cf. `TaskDetail`).
 * Les routines, événements, checklists, objectif épinglé, réordonnancement, mode
 * édition et vue compacte arrivent avec leurs stories respectives (A-02 à A-06, M4,
 * M6, M7, M17) : rien n'est simulé ici pour ces parties.
 */
export function TodayScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  // Espaces (ES-01) : lus une fois dans useAppStore (App.tsx, via SpaceRepository),
  // jamais importés depuis db/seed dans une feature.
  const spaces = useAppStore((s) => s.spaces);
  const fallbackSpaceId: SpaceId | null = spaces[0]?.id ?? null;

  const taskIds = useFeatureStore(todayStore, (s) => s.taskIds);
  const entities = useTaskEntities();
  const recurrences = useFeatureStore(todayStore, (s) => s.recurrences);
  const viewDate = useFeatureStore(todayStore, (s) => s.date);
  const viewFilter = useFeatureStore(todayStore, (s) => s.filter);
  const extras = useFeatureStore(todayStore, (s) => s.extras);
  const extrasFailed = useFeatureStore(todayStore, (s) => s.extrasFailed);
  const hideRoutines = useFeatureStore(todayStore, (s) => s.hideRoutines);
  const toggleRoutine = useFeatureStore(todayStore, (s) => s.toggleRoutine);
  const moveRow = useFeatureStore(todayStore, (s) => s.moveRow);
  const actionErrorKey = useFeatureStore(todayStore, (s) => s.actionErrorKey);
  const status = useFeatureStore(todayStore, (s) => s.status);
  const errorKey = useFeatureStore(todayStore, (s) => s.errorKey);
  const load = useFeatureStore(todayStore, (s) => s.load);
  const addTask = useFeatureStore(todayStore, (s) => s.addTask);
  const toggleDone = useFeatureStore(todayStore, (s) => s.toggleDone);
  const postpone = useFeatureStore(todayStore, (s) => s.postpone);
  const postponeSeries = useFeatureStore(todayStore, (s) => s.postponeSeries);
  const remove = useFeatureStore(todayStore, (s) => s.remove);
  const duplicate = useFeatureStore(todayStore, (s) => s.duplicate);
  const syncRecurrences = useFeatureStore(todayStore, (s) => s.syncRecurrences);
  const openDetail = useNavigationStore((s) => s.openDetail);
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
  const dayTasks = useMemo(
    () => selectTodayTasks(taskIds, entities, { date: viewDate, filter: viewFilter }),
    [taskIds, entities, viewDate, viewFilter],
  );
  // Assemblage de la liste du jour (domaine) : objectif, événements, routines et tâches mêlées, terminés, checklists.
  const list = useMemo(
    () =>
      buildTodayList({
        date: viewDate ?? viewedDate,
        filter: viewFilter,
        tasks: dayTasks,
        routines: extras.routines,
        events: extras.events,
        checklists: extras.checklists,
        goal: extras.goal,
        hideRoutines,
      }),
    [dayTasks, extras, hideRoutines, viewDate, viewedDate, viewFilter],
  );
  const routinesCheckable = canToggleRoutines();


  // Ligne « sélectionnée » au clavier (critère 6, PC) : la dernière ligne ayant
  // reçu le focus (case ou titre), via `onFocus` posé sur le conteneur de chaque
  // ligne (React délègue `onFocus` sur `focusin`, qui remonte depuis les enfants).
  // Pas de surcouche de sélection dédiée : A-02 (flèches haut/bas, Alt+↑/↓)
  // branchera `list.previous` / `list.next` sur ce même état le moment venu.
  const [focusedTaskId, setFocusedTaskId] = useState<TaskId | null>(null);
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.complete', () => void toggleDone(focusedTaskId));
  }, [container, focusedTaskId, toggleDone]);

  // Ctrl+D (T-05, critère 5) : reporte à demain la ligne sélectionnée. Occurrence récurrente : la question
  // « Cette occurrence / Toutes les suivantes » est posée d'abord (T-10 critère 4).
  const [postponeSeriesId, setPostponeSeriesId] = useState<TaskId | null>(null);
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.postponeTomorrow', () => {
      const task = container.taskEntities.get(focusedTaskId);
      if (task?.recurrenceId && task.status === 'todo') setPostponeSeriesId(focusedTaskId);
      else void postpone(focusedTaskId, 'tomorrow');
    });
  }, [container, focusedTaskId, postpone]);
  const postponeSeriesTask = postponeSeriesId ? entities.get(postponeSeriesId) : undefined;

  // Suppr (T-08, critère 1) : demande confirmation pour la ligne sélectionnée ; rien n'est
  // supprimé avant la confirmation. Le raccourci ne s'applique pas dans un champ de saisie (shortcuts.ts).
  const [deleteTargetId, setDeleteTargetId] = useState<TaskId | null>(null);
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.delete', () => {
      if (container.taskEntities.get(focusedTaskId)) setDeleteTargetId(focusedTaskId);
    });
  }, [container, focusedTaskId]);
  const deleteTarget = deleteTargetId ? entities.get(deleteTargetId) : undefined;

  // Ctrl+Maj+D (T-12, critère 1) : ouvre le choix de la date de la copie pour la ligne sélectionnée
  // (présélectionnée sur la date de l'original) ; rien n'est créé avant la validation.
  const [duplicateTargetId, setDuplicateTargetId] = useState<TaskId | null>(null);
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.duplicate', () => {
      if (container.taskEntities.get(focusedTaskId)) setDuplicateTargetId(focusedTaskId);
    });
  }, [container, focusedTaskId]);
  const duplicateTarget = duplicateTargetId ? entities.get(duplicateTargetId) : undefined;

  // Réordonnancement (A-02) : glisser à la souris (ligne) ou au toucher (poignée du mode édition, A-05), Alt+↑/↓.
  // Le domaine ramène une destination interdite par l'heure (Q11) ; le résultat est annoncé aux lecteurs d'écran.
  const [announcement, setAnnouncement] = useState<{ readonly text: string; readonly n: number } | null>(null);
  const focusAfterMove = useRef<string | null>(null);
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  });
  const applyMove = useCallback(
    async (id: string, toIndex: number): Promise<void> => {
      const outcome = await moveRow(listRef.current.rows, id, toIndex);
      if (!outcome) return;
      focusAfterMove.current = id;
      const text =
        outcome.changes.length === 0 && outcome.clamped
          ? t('today.moveUnchanged')
          : t('today.moved', { position: outcome.toIndex + 1, total: outcome.total });
      setAnnouncement((previous) => ({ text, n: (previous?.n ?? 0) + 1 }));
    },
    [moveRow],
  );
  const sortable = useSortable({
    ids: list.rows.map((row) => row.id),
    isMovable: (id) => list.rows.some((row) => row.id === id && row.kind === 'task'),
    onMove: (id, toIndex) => void applyMove(id, toIndex),
  });
  // Le focus suit la ligne déplacée (critère 3).
  useEffect(() => {
    const id = focusAfterMove.current;
    if (!id) return;
    focusAfterMove.current = null;
    document.querySelector<HTMLElement>(`[data-sortable-id="${id}"] .ct-list-row__title`)?.focus();
  });
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    const move = (delta: number) => () => {
      const index = listRef.current.rows.findIndex((row) => row.id === focusedTaskId);
      if (index >= 0) void applyMove(focusedTaskId, index + delta);
    };
    const offUp = container.shortcuts.register('list.moveUp', move(-1));
    const offDown = container.shortcuts.register('list.moveDown', move(1));
    return () => {
      offUp();
      offDown();
    };
  }, [container, focusedTaskId, applyMove]);

  const [inlineTitle, setInlineTitle] = useState('');
  // Champ « Date » de la saisie PC (T-14) : saisie libre et mini-calendrier ; null = jour affiché.
  const [inlineChoice, setInlineChoice] = useState<DateChoice | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTitle, setSheetTitle] = useState('');
  // Roues de la feuille « Nouvelle tâche » (T-14) : « Aujourd'hui » à l'ouverture, sans heure (Q9).
  const [sheetChoice, setSheetChoice] = useState<DateChoice>({ date: null, time: null });
  const [sheetSpaceId, setSheetSpaceId] = useState<SpaceId | null>(null);
  // Choix Icône / Emoji de la feuille « Nouvelle tâche » (T-03, Ajout.html,
  // `IconChooser`) : pas de champ équivalent côté PC (la saisie en ligne n'a pas
  // de maquette pour l'icône, choisie ensuite dans la fiche détail, critère 5).
  const [sheetIcon, setSheetIcon] = useState<IconRef | null>(null);
  // Répétition (T-09, Ajout.html) : « Une fois » par défaut ; date de départ = date saisie ou jour affiché.
  const [sheetRecurrence, setSheetRecurrence] = useState<RecurrenceFields | null>(null);
  const sheetTitleRef = useRef<HTMLInputElement>(null);

  // T-09 : une règle posée depuis la fiche apparaît aussitôt sur la ligne (lecture des règles inconnues).
  const hasUnknownRule = dayTasks.some((task) => task.recurrenceId !== null && !recurrences.has(task.recurrenceId));
  useEffect(() => {
    if (hasUnknownRule) void syncRecurrences();
  }, [hasUnknownRule, syncRecurrences]);

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
      if (viewFilter !== 'all' && task.spaceId !== viewFilter) continue;
      adoptTried.current.add(task.id);
      missing = true;
    }
    if (missing) void load(viewDate, viewFilter);
  }, [entities, taskIds, viewDate, viewFilter, status, load]);

  // Déplace le focus dans le champ Titre après l'ouverture de la feuille : le DOM
  // suit l'ordre visuel de la maquette (en-tête puis champ Titre), donc le piège de
  // focus de `Sheet` pose d'abord le focus sur le bouton « Fermer » (premier élément
  // focusable). Le `setTimeout` s'exécute après les effets passifs de React (ceux de
  // `Sheet` compris), quel que soit leur ordre relatif, pour corriger le focus sans
  // dépendre de l'ordre du DOM (pas de `order` CSS).
  useEffect(() => {
    if (!sheetOpen) return undefined;
    const id = window.setTimeout(() => sheetTitleRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [sheetOpen]);

  const openCreate = useCallback((): void => {
    if (layout === 'pc') {
      inlineInputRef.current?.focus();
      return;
    }
    setSheetTitle('');
    setSheetChoice({ date: viewedDate, time: null });
    setSheetSpaceId(fallbackSpaceId ? resolveDefaultSpaceId(spaceFilter, fallbackSpaceId) : null);
    setSheetIcon(null);
    setSheetRecurrence(null);
    setSheetOpen(true);
  }, [layout, spaceFilter, fallbackSpaceId, viewedDate]);

  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  // D-01 : « Ajout rapide » de la zone de notification = même comportement que Ctrl+N.
  // Abonnement au store plutôt qu'état lu au rendu : une demande faite avant le montage est prise
  // au premier passage de la minuterie (après les effets de l'écran), une seule fois.
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

  async function handleInlineSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!fallbackSpaceId) return;
    const spaceId = resolveDefaultSpaceId(spaceFilter, fallbackSpaceId);
    const result = await addTask(inlineTitle, spaceId, scheduleOf(inlineChoice));
    if (result.ok) {
      setInlineTitle('');
      setInlineChoice(null);
      inlineInputRef.current?.focus();
    }
  }

  const sheetTitleValid = validateTaskTitle(sheetTitle).ok;

  async function handleSheetSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!sheetTitleValid || !sheetSpaceId) return;
    const result = await addTask(sheetTitle, sheetSpaceId, { ...scheduleOf(sheetChoice), recurrence: sheetChoice.date === null ? null : sheetRecurrence }, sheetIcon);
    if (result.ok) setSheetOpen(false);
  }

  const iconSize = layout === 'pc' ? 24 : 28;

  function renderTaskRow(row: Extract<TodayRow, { kind: 'task' }>) {
    const task = row.task;
    return (
      <ListRow
        title={task.title}
        subtitle={taskSubtitle(task, { spaces, showSpace: spaceFilter === 'all', rule: task.recurrenceId ? recurrences.get(task.recurrenceId) : undefined })}
        done={task.status === 'done'}
        leading={
          <Checkbox
            checked={task.status === 'done'}
            onChange={() => void toggleDone(task.id)}
            label={t(task.status === 'done' ? 'tasks.reopen' : 'tasks.complete', { title: task.title })}
          />
        }
        icon={task.icon ? <IconView icon={task.icon} color={resolveIconRefColor(task.icon)} size={iconSize} /> : undefined}
        onActivate={() => openDetail({ type: 'task', id: task.id })}
      />
    );
  }

  /** Routine du jour (M4) : « HH:MM · Routine », icône à droite ; sa case existe quand une source sait valider (R-03). */
  function renderRoutineRow(row: Extract<TodayRow, { kind: 'routine' }>) {
    const { routine } = row;
    const time = rowTime(row);
    return (
      <ListRow
        title={routine.title}
        subtitle={time ? `${time} · ${t('today.routineLabel')}` : t('today.routineLabel')}
        done={row.done}
        {...(routinesCheckable
          ? {
              leading: (
                <Checkbox
                  checked={row.done}
                  onChange={() => void toggleRoutine(routine.id as RoutineId)}
                  label={t(row.done ? 'tasks.reopen' : 'tasks.complete', { title: routine.title })}
                />
              ),
            }
          : {})}
        icon={routine.icon ? <IconView icon={routine.icon} color={resolveIconRefColor(routine.icon)} size={iconSize} /> : undefined}
      />
    );
  }

  return (
    <div className="ct-today-shell" data-layout={layout}>
      <div className="ct-today" data-layout={layout}>
        {/* Icône graphique « Rapport mensuel » (Main.html, T-07 / Q5) ; les autres icônes d'accès
            rapide (Un jour, Objectif, Recherche) arrivent avec leurs stories. */}
        <div className="ct-today__quickIcons">
          <button
            type="button"
            className="ct-today__iconButton"
            aria-label={t('report.openFromToday')}
            onClick={() => navigate({ tab: 'tasks', screen: 'report' })}
          >
            <Icon icon={ChartColumn} size={layout === 'pc' ? 24 : 26} />
          </button>
        </div>

        <TodayHeader
          date={viewedDate}
          today={today}
          layout={layout}
          {...(layout === 'pc' ? { onPreviousDay: () => goToDay(addDays(viewedDate, -1)), onNextDay: () => goToDay(addDays(viewedDate, 1)) } : {})}
        />

        <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />

        {actionErrorKey && <p className="ct-today__error" role="alert">{t(actionErrorKey)}</p>}
        {carryOverFailed && <p className="ct-today__error" role="alert">{t('tasks.carryOverError')}</p>}
        {recurrenceFailed && <p className="ct-today__error" role="alert">{t('tasks.recurrenceError')}</p>}
        {extrasFailed && <p className="ct-today__error" role="alert">{t('today.sourceError')}</p>}
        {status === 'error' && errorKey && <p className="ct-today__error" role="alert">{t(errorKey)}</p>}

        {status === 'error' ? null : (
          <>
            {(list.goal || list.events.length > 0) && (
              <div className="ct-today-banners" data-layout={layout}>
                {list.goal && <TodayGoalCard entry={list.goal} compact={false} />}
                <TodayEventBands events={list.events} compact={false} />
              </div>
            )}
            {status === 'ready' && list.isEmpty && (
              <TodayEmpty message={viewedDate === today ? t('tasks.emptyToday') : t('today.emptyDay', { weekday: formatWeekdayName(viewedDate) })} />
            )}
            {(list.rows.length > 0 || list.doneRows.length > 0) && (
              <div {...sortable.containerProps} className={`ct-today__list ${sortable.containerProps.className}`} aria-label={t('today.listLabel')} role="list">
                {list.rows.map((row) => (
                  <div
                    key={row.id}
                    role="listitem"
                    onFocus={() => row.kind === 'task' && setFocusedTaskId(row.task.id)}
                    {...sortable.itemProps(row.id)}
                    {...(row.kind === 'task' ? sortable.dragProps(row.id, 'row') : {})}
                  >
                    {row.kind === 'task' ? renderTaskRow(row) : renderRoutineRow(row)}
                  </div>
                ))}
                {list.doneRows.map((row) => (
                  <div key={row.id} role="listitem" onFocus={() => row.kind === 'task' && setFocusedTaskId(row.task.id)}>
                    {row.kind === 'task' ? renderTaskRow(row) : renderRoutineRow(row)}
                  </div>
                ))}
              </div>
            )}
            <TodayChecklists items={list.checklists} />
            {/* Annonce du déplacement aux lecteurs d'écran (A-02 critère 3) ; ni role="status" (réservé au bandeau « Annuler »). */}
            <div key={announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
              {announcement?.text}
            </div>
          </>
        )}

        <form className="ct-today__addRow" onSubmit={handleInlineSubmit}>
          <TextField
            ref={inlineInputRef}
            label={t('tasks.newTask')}
            placeholder={t(layout === 'pc' ? 'tasks.addPlaceholderPc' : 'tasks.addPlaceholder')}
            value={inlineTitle}
            onChange={setInlineTitle}
            maxLength={TASK_TITLE_MAX_LENGTH}
          />
          {/* Champ « Date » PC (T-14, PC-Date.html) : saisie libre (« demain », « lun. 10h ») et mini-calendrier,
              facultatif. Seulement sur PC : sur iPhone, la saisie rapide passe par la feuille « Nouvelle tâche »
              (Fab), qui porte les roues de date — éviter deux sélecteurs visibles à la fois. */}
          {layout === 'pc' && (
            <DatePicker value={inlineChoice} today={today} onChange={setInlineChoice} className="ct-today__dateField" />
          )}
          {/* Bouton d'envoi masqué : avec deux champs texte (titre, date), Entrée ne soumet le formulaire que par lui. */}
          <button type="submit" className="ct-visually-hidden" tabIndex={-1} aria-hidden="true" />
        </form>

        <div className="ct-today__bottomRow">
          <Fab onClick={openCreate} label={t('common.add')} />
        </div>

        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} label={t('tasks.newTask')}>
          <form className="ct-task-sheet" onSubmit={handleSheetSubmit}>
            <div className="ct-task-sheet__header">
              <h2 className="ct-task-sheet__heading">{t('tasks.newTask')}</h2>
              <button type="button" className="ct-task-sheet__close" aria-label={t('common.close')} onClick={() => setSheetOpen(false)}>
                <Icon icon={X} />
              </button>
            </div>
            <TextField
              ref={sheetTitleRef}
              label={t('tasks.titleLabel')}
              value={sheetTitle}
              onChange={setSheetTitle}
              maxLength={TASK_TITLE_MAX_LENGTH}
            />

            {/* Choix Icône / Emoji (T-03, critères 1, 2, Ajout.html). */}
            <IconChooser value={sheetIcon} onChange={setSheetIcon} />

            {/* Puces et roues jour / heure / minutes (T-14, Ajout.html). */}
            <DatePicker value={sheetChoice} today={today} onChange={(choice) => setSheetChoice(choice ?? { date: today, time: null })} />
            <RecurrencePicker
              value={sheetRecurrence}
              onChange={setSheetRecurrence}
              startDate={sheetChoice.date ?? viewedDate}
            />
            <div className="ct-task-sheet__spaces" role="group" aria-label={t('spaces.filterLabel')}>
              {spaces.map((space) => (
                <button
                  key={space.id}
                  type="button"
                  aria-pressed={sheetSpaceId === space.id}
                  className="ct-task-sheet__spaceButton"
                  style={{ '--ct-space-color': space.color } as CSSProperties}
                  onClick={() => setSheetSpaceId(space.id)}
                >
                  {space.name}
                </button>
              ))}
            </div>
            <div className="ct-task-sheet__spacer" />
            <Button type="submit" fullWidth disabled={!sheetTitleValid || !sheetSpaceId}>
              {t('tasks.save')}
            </Button>
          </form>
        </Sheet>
      </div>

      <TaskDetail />

      {postponeSeriesTask && (
        <ChoiceDialog
          title={t('tasks.seriesPostponeTitle', { title: postponeSeriesTask.title })}
          description={t('tasks.seriesPostponeBody')}
          options={[
            { id: 'occurrence', label: t('tasks.seriesScopeOccurrence') },
            { id: 'following', label: t('tasks.seriesScopeFollowing') },
          ]}
          onChoose={(scope) => {
            setPostponeSeriesId(null);
            void postponeSeries(postponeSeriesTask.id, 'tomorrow', scope);
          }}
          onCancel={() => setPostponeSeriesId(null)}
        />
      )}

      {duplicateTarget && (
        <DuplicatePrompt
          task={duplicateTarget}
          onClose={() => setDuplicateTargetId(null)}
          onConfirm={(date) => {
            setDuplicateTargetId(null);
            void duplicate(duplicateTarget.id, date);
          }}
        />
      )}

      {deleteTarget && (
        <DeleteTaskConfirm
          task={deleteTarget}
          onCancel={() => setDeleteTargetId(null)}
          onConfirm={(scope) => {
            setDeleteTargetId(null);
            void remove(deleteTarget.id, scope);
          }}
        />
      )}
    </div>
  );
}
