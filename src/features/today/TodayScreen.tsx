import { X } from 'lucide-react';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { TASK_TITLE_MAX_LENGTH, resolveDefaultSpaceId, validateTaskTitle } from '../../domain/taskRules';
import { asLocalDate, asLocalTime, type SpaceId } from '../../domain/types';
import { getLocale, t } from '../../i18n';
import { Button, Fab, Icon, ListRow, Sheet, SpacePills, TextField, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import type { NewTaskSchedule } from './todayStore';
import { todayStore } from './todayStore';
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
 * pastilles d'espace, liste des tâches du jour (titre seul) et création rapide.
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

  const tasks = useFeatureStore(todayStore, (s) => s.tasks);
  const status = useFeatureStore(todayStore, (s) => s.status);
  const errorKey = useFeatureStore(todayStore, (s) => s.errorKey);
  const load = useFeatureStore(todayStore, (s) => s.load);
  const addTask = useFeatureStore(todayStore, (s) => s.addTask);

  const today = todayLocal(container.clock);
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
  const sheetTitleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load(today, spaceFilter);
    // `today` est stable le temps de la session (pas de minuit simulé ici, T-06) ;
    // seul un changement de filtre doit recharger la liste. `load` ne rejette jamais.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceFilter]);

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
    const result = await addTask(sheetTitle, sheetSpaceId, readSchedule(sheetDate, sheetTime));
    if (result.ok) setSheetOpen(false);
  }

  return (
    <div className="ct-today" data-layout={layout}>
      <div className="ct-today__header">
        <span className="ct-today__month">{header.monthLine}</span>
        <div className="ct-today__dateRow">
          <h1 className="ct-today__day">{header.dayLine}</h1>
          <span className="ct-today__badge">{t('tasks.todayBadge')}</span>
        </div>
      </div>

      <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />

      {status === 'error' && errorKey && <p className="ct-today__error" role="alert">{t(errorKey)}</p>}

      {status === 'error' ? null : tasks.length === 0 ? (
        <p className="ct-today__empty">{t('tasks.emptyToday')}</p>
      ) : (
        <div className="ct-today__list">
          {tasks.map((task) => (
            <ListRow key={task.id} title={task.title} subtitle={task.time ?? undefined} done={task.status === 'done'} />
          ))}
        </div>
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
  );
}
