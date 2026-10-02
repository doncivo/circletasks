import { ChartColumn, X } from 'lucide-react';
import { type CSSProperties, type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import type { Space, Task } from '../../domain/model';
import type { IconRef } from '../../domain/model/icon';
import { TASK_TITLE_MAX_LENGTH, resolveDefaultSpaceId, validateTaskTitle } from '../../domain/taskRules';
import { asLocalDate, asLocalTime, type SpaceId, type TaskId } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { Button, Checkbox, Fab, Icon, IconChooser, IconView, ListRow, Sheet, SpacePills, TextField, resolveIconRefColor, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { TaskDetail } from '../tasks';
import type { NewTaskSchedule } from './todayStore';
import { resolveTodayTasks, todayStore } from './todayStore';
import { UndoToast } from './UndoToast';
import './TodayScreen.css';

function formatTodayHeader(isoDate: string): { monthLine: string; dayLine: string } {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const monthLine = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date);
  return { monthLine, dayLine: `${String(day ?? 1)} ${weekday}` };
}

/**
 * Sous-ligne d'une tâche : heure ; une tâche reportée automatiquement (T-06) ajoute le
 * badge « reportée » et l'espace en couleur (« reportée · Pro », PC-Semaine.html).
 */
function taskSubtitle(task: Task, spaces: readonly Space[]): ReactNode {
  if (!task.carriedOver) return task.time ?? undefined;
  const space = spaces.find((s) => s.id === task.spaceId);
  return (
    <>
      {task.time ? `${task.time} · ` : ''}
      <span className="ct-today__carried">{t('tasks.carriedOver')}</span>
      {space && (
        <>
          {' · '}
          <span style={{ color: space.color }}>{space.name}</span>
        </>
      )}
    </>
  );
}

/**
 * Lit les champs natifs `<input type="date">` / `<input type="time">` (T-02,
 * champ minimal remplacé par le sélecteur adapté à l'appareil de T-14) : chaîne
 * vide = non fourni (jour affiché par défaut pour la date, pas d'heure).
 */
function readSchedule(dateValue: string, timeValue: string): NewTaskSchedule {
  // `exactOptionalPropertyTypes` (tsconfig) : on n'inclut `date` / `time` que
  // lorsqu'une valeur est saisie, plutôt que de les poser à `undefined`.
  return {
    ...(dateValue !== '' ? { date: asLocalDate(dateValue) } : {}),
    ...(timeValue !== '' ? { time: asLocalTime(timeValue) } : {}),
  };
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
  const viewDate = useFeatureStore(todayStore, (s) => s.date);
  const viewFilter = useFeatureStore(todayStore, (s) => s.filter);
  // Date et espace revérifiés à chaque rendu (selectTasks) : une tâche reportée quitte la liste aussitôt (T-05).
  const tasks = useMemo(
    () => resolveTodayTasks(taskIds, entities, { date: viewDate, filter: viewFilter }),
    [taskIds, entities, viewDate, viewFilter],
  );
  const actionErrorKey = useFeatureStore(todayStore, (s) => s.actionErrorKey);
  const status = useFeatureStore(todayStore, (s) => s.status);
  const errorKey = useFeatureStore(todayStore, (s) => s.errorKey);
  const load = useFeatureStore(todayStore, (s) => s.load);
  const addTask = useFeatureStore(todayStore, (s) => s.addTask);
  const toggleDone = useFeatureStore(todayStore, (s) => s.toggleDone);
  const postpone = useFeatureStore(todayStore, (s) => s.postpone);
  const openDetail = useNavigationStore((s) => s.openDetail);
  const navigate = useNavigationStore((s) => s.navigate);

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

  // Ctrl+D (T-05, critère 5) : reporte à demain la ligne sélectionnée.
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.postponeTomorrow', () => void postpone(focusedTaskId, 'tomorrow'));
  }, [container, focusedTaskId, postpone]);

  // Jour courant de l'app (T-06) : suit le passage de minuit (rollover) ; horloge avant le premier contrôle.
  const appDay = useAppStore((s) => s.day);
  const carryOverFailed = useAppStore((s) => s.carryOverFailed);
  const today = appDay ?? todayLocal(container.clock);
  const header = formatTodayHeader(today);

  const [inlineTitle, setInlineTitle] = useState('');
  // Champ Date / Heure minimal (T-02) : natif, remplacé par le sélecteur adapté à
  // l'appareil (roue iPhone, mini-calendrier et saisie libre PC) de T-14.
  const [inlineDate, setInlineDate] = useState('');
  const [inlineTime, setInlineTime] = useState('');
  const inlineInputRef = useRef<HTMLInputElement>(null);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTitle, setSheetTitle] = useState('');
  const [sheetDate, setSheetDate] = useState('');
  const [sheetTime, setSheetTime] = useState('');
  const [sheetSpaceId, setSheetSpaceId] = useState<SpaceId | null>(null);
  // Choix Icône / Emoji de la feuille « Nouvelle tâche » (T-03, Ajout.html,
  // `IconChooser`) : pas de champ équivalent côté PC (la saisie en ligne n'a pas
  // de maquette pour l'icône, choisie ensuite dans la fiche détail, critère 5).
  const [sheetIcon, setSheetIcon] = useState<IconRef | null>(null);
  const sheetTitleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load(today, spaceFilter);
    // Recharge au changement de filtre et au passage de minuit (T-06, `today` suit `appDay`).
    // `load` ne rejette jamais.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceFilter, today]);

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
    setSheetDate('');
    setSheetTime('');
    setSheetSpaceId(fallbackSpaceId ? resolveDefaultSpaceId(spaceFilter, fallbackSpaceId) : null);
    setSheetIcon(null);
    setSheetOpen(true);
  }, [layout, spaceFilter, fallbackSpaceId]);

  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  async function handleInlineSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!fallbackSpaceId) return;
    const spaceId = resolveDefaultSpaceId(spaceFilter, fallbackSpaceId);
    const result = await addTask(inlineTitle, spaceId, readSchedule(inlineDate, inlineTime));
    if (result.ok) {
      setInlineTitle('');
      setInlineDate('');
      setInlineTime('');
      inlineInputRef.current?.focus();
    }
  }

  const sheetTitleValid = validateTaskTitle(sheetTitle).ok;

  async function handleSheetSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!sheetTitleValid || !sheetSpaceId) return;
    const result = await addTask(sheetTitle, sheetSpaceId, readSchedule(sheetDate, sheetTime), sheetIcon);
    if (result.ok) setSheetOpen(false);
  }

  return (
    <div className="ct-today-shell" data-layout={layout}>
      <div className="ct-today">
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

        <div className="ct-today__header">
          <span className="ct-today__month">{header.monthLine}</span>
          <div className="ct-today__dateRow">
            <h1 className="ct-today__day">{header.dayLine}</h1>
            <span className="ct-today__badge">{t('tasks.todayBadge')}</span>
          </div>
        </div>

        <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />

        {actionErrorKey && <p className="ct-today__error" role="alert">{t(actionErrorKey)}</p>}
        {carryOverFailed && <p className="ct-today__error" role="alert">{t('tasks.carryOverError')}</p>}
        {status === 'error' && errorKey && <p className="ct-today__error" role="alert">{t(errorKey)}</p>}

        {status === 'error' ? null : tasks.length === 0 ? (
          <p className="ct-today__empty">{t('tasks.emptyToday')}</p>
        ) : (
          <div className="ct-today__list">
            {tasks.map((task) => (
              <div key={task.id} onFocus={() => setFocusedTaskId(task.id)}>
                <ListRow
                  title={task.title}
                  subtitle={taskSubtitle(task, spaces)}
                  done={task.status === 'done'}
                  leading={
                    <Checkbox
                      checked={task.status === 'done'}
                      onChange={() => void toggleDone(task.id)}
                      label={t(task.status === 'done' ? 'tasks.reopen' : 'tasks.complete', { title: task.title })}
                    />
                  }
                  icon={task.icon ? <IconView icon={task.icon} color={resolveIconRefColor(task.icon)} size={layout === 'pc' ? 24 : 28} /> : undefined}
                  onActivate={() => openDetail({ type: 'task', id: task.id })}
                />
              </div>
            ))}
          </div>
        )}

        {/* Bandeau « Annuler » (T-04) après une complétion, branché sur `UndoStack`
            (ADR 0005) ; T-13 généralisera son emplacement aux autres actions. */}
        <UndoToast />

        <form className="ct-today__addRow" onSubmit={handleInlineSubmit}>
          <TextField
            ref={inlineInputRef}
            label={t('tasks.newTask')}
            placeholder={t(layout === 'pc' ? 'tasks.addPlaceholderPc' : 'tasks.addPlaceholder')}
            value={inlineTitle}
            onChange={setInlineTitle}
            maxLength={TASK_TITLE_MAX_LENGTH}
          />
          {/* Champ Date / Heure minimal (T-02), remplacé par le sélecteur adapté à
              l'appareil de T-14 : saisie native, optionnelle. Seulement sur PC : sur
              iPhone, la saisie rapide passe par la feuille « Nouvelle tâche »
              (Fab), qui porte ses propres champs Date / Heure — éviter deux champs
              de même libellé visibles à la fois. */}
          {layout === 'pc' && (
            <>
              <label className="ct-today__scheduleField">
                <span className="ct-visually-hidden">{t('tasks.dateLabel')}</span>
                <input
                  type="date"
                  value={inlineDate}
                  onChange={(event) => setInlineDate(event.target.value)}
                  className="ct-today__scheduleInput"
                />
              </label>
              <label className="ct-today__scheduleField">
                <span className="ct-visually-hidden">{t('tasks.timeLabel')}</span>
                <input
                  type="time"
                  value={inlineTime}
                  onChange={(event) => setInlineTime(event.target.value)}
                  className="ct-today__scheduleInput"
                />
              </label>
            </>
          )}
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

            {/* Champ Date / Heure minimal (T-02), remplacé par la feuille de roues de
                T-14 : saisie native, optionnelle (date vide = jour affiché, pas de puce
                « Un jour » avant T-14). */}
            <div className="ct-task-sheet__schedule">
              <label className="ct-task-sheet__scheduleField">
                <span className="ct-text-field__label">{t('tasks.dateLabel')}</span>
                <input
                  type="date"
                  value={sheetDate}
                  onChange={(event) => setSheetDate(event.target.value)}
                  className="ct-text-field__control"
                />
              </label>
              <label className="ct-task-sheet__scheduleField">
                <span className="ct-text-field__label">{t('tasks.timeLabel')}</span>
                <input
                  type="time"
                  value={sheetTime}
                  onChange={(event) => setSheetTime(event.target.value)}
                  className="ct-text-field__control"
                />
              </label>
            </div>
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
    </div>
  );
}
