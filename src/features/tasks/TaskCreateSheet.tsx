import { X } from 'lucide-react';
import { startTransition, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, Space } from '../../domain/model';
import { offsetsAfterTimeChange, toggleReminderOffset } from '../../domain/reminders';
import { TASK_TITLE_MAX_LENGTH, validateTaskTitle } from '../../domain/taskRules';
import type { GoalId, LocalDate, ProjectId, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { AddSegments, Button, DatePicker, Icon, IconChooser, QuickInputField, QuickPreview, RecurrencePicker, Sheet, SpaceSegmented, type AddSegment } from '../../ui';
import { DictationButton, DictationHelp, ListeningSheet, useDictation, useQuickInput } from '../capture';
import { useNoticeStore } from '../app/notice';
import { GoalAttachSwitch } from '../goals/GoalAttachSwitch';
import { ReminderBlock } from '../reminders';
import { ProjectSelect } from '../spaces';
import type { NewTaskSchedule } from './taskUseCases';

/**
 * Planification choisie dans le sélecteur de date (T-14) : aucun choix = jour affiché ; « Un jour » = tâche
 * sans date ; sinon date et heure optionnelle.
 */
export function scheduleOf(choice: DateChoice | null): NewTaskSchedule {
  // `exactOptionalPropertyTypes` (tsconfig) : on n'inclut `date` / `time` que lorsqu'une valeur est choisie.
  if (choice === null) return {};
  if (choice.date === null) return { someday: true };
  return { date: choice.date, ...(choice.time !== null ? { time: choice.time } : {}) };
}

/** Q-05 : une écriture qui n'aboutit pas dans ce délai (base occupée par une sauvegarde ou la synchro) affiche « La base n'est pas prête ». */
export const CREATE_NOT_READY_MS = 2000;
/** Durée de l'animation du champ qui tremble (titre vide refusé) ; sans animation si l'utilisateur la réduit (CSS). */
const SHAKE_MS = 450;

type SheetNotice = 'not-ready' | 'failed';

/** Une écriture lancée par la feuille ; `abandoned` : « Réessayer » en a lancé une autre à sa place (celle-ci ne décide plus de la feuille). */
interface Attempt {
  readonly title: string;
  abandoned: boolean;
  readonly promise: Promise<boolean>;
}

export interface TaskCreateSheetProps {
  readonly viewedDate: LocalDate;
  readonly today: LocalDate;
  readonly spaces: readonly Space[];
  /** Espace présélectionné (filtre actif, ES-02). */
  readonly initialSpaceId: SpaceId | null;
  /** Projet présélectionné (filtre projet actif, QB-15) ; seulement s'il appartient à l'espace présélectionné. */
  readonly initialProjectId?: ProjectId | null;
  /** Avances cochées d'office à la première heure donnée (`reminders.defaultOffsets`, QB-08) ; [0] par défaut. */
  readonly defaultOffsets?: readonly ReminderOffsetMin[];
  /** « Un jour » présélectionné (SD-01 critère 5 : bouton « + » de l'écran Un jour) : roues et champ de date masqués d'office. */
  readonly initialSomeday?: boolean;
  /** Titre déjà saisi dans un autre segment de la feuille Ajout (E-01 critère 2 : changer de segment conserve le titre). */
  readonly initialTitle?: string;
  /** Affiche les segments Tâche / Événement / Routine ; appelé avec le segment choisi et le titre saisi. */
  readonly onSegmentChange?: (segment: AddSegment, title: string) => void;
  readonly onClose: () => void;
  readonly onCreate: (input: {
    title: string;
    spaceId: SpaceId;
    projectId: ProjectId | null;
    choice: DateChoice;
    recurrence: RecurrenceFields | null;
    icon: IconRef | null;
    reminderOffsets: readonly ReminderOffsetMin[];
    /** OB-03 : objectif auquel la tâche est rattachée à sa création. */
    goalId: GoalId | null;
  }) => Promise<boolean>;
}

/**
 * Feuille « Nouvelle tâche » (iPhone, Ajout.html) : titre, icône, roues de date (« Aujourd'hui » / jour affiché, sans heure,
 * Q9), répétition, espace. Montée à l'ouverture seulement : son état part de zéro à chaque fois.
 */
export function TaskCreateSheet({ viewedDate, today, spaces, initialSpaceId, initialProjectId = null, defaultOffsets = [0], initialSomeday = false, initialTitle = '', onSegmentChange, onClose, onCreate }: TaskCreateSheetProps) {
  const [choiceTouched, setChoiceTouched] = useState(false);
  // Q-06, Q-02 : marques # et @ et date écrites dans le titre ; la date choisie à la main (roues, puces) l'emporte sur celle du texte.
  const quick = useQuickInput({ dates: !choiceTouched && !initialSomeday, initialText: initialTitle });
  const { setText: setTitle } = quick;
  const title = quick.text;
  const [choice, setChoice] = useState<DateChoice>(initialSomeday ? { date: null, time: null } : { date: viewedDate, time: null });
  const [spaceId, setSpaceId] = useState<SpaceId | null>(initialSpaceId);
  const [projectId, setProjectId] = useState<ProjectId | null>(initialProjectId);
  const [icon, setIcon] = useState<IconRef | null>(null);
  const [recurrence, setRecurrence] = useState<RecurrenceFields | null>(null);
  const [goalId, setGoalId] = useState<GoalId | null>(null);
  const [offsets, setOffsets] = useState<readonly ReminderOffsetMin[]>([]);
  const [offsetsTouched, setOffsetsTouched] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  // Q-05 : création en cours (une seule à la fois, même après le message « base non prête » : « Réessayer » la reprend au lieu d'en lancer une seconde).
  const pending = useRef<Attempt | null>(null);
  const mounted = useRef(true);
  const onCloseRef = useRef(onClose);
  const [notice, setNotice] = useState<SheetNotice | null>(null);
  const [shaking, setShaking] = useState(false);
  // Écriture en cours (revue QA D1) : le formulaire est figé tant qu'elle n'est pas terminée, pour qu'aucune modification ne soit perdue en silence
  // (la reprise par « Réessayer » porte le texte déjà envoyé).
  const [waiting, setWaiting] = useState(false);
  const fieldsRef = useRef<HTMLDivElement>(null);
  // Bas de la feuille rendu après le premier affichage (transition) : l'ouverture ne paie que l'en-tête, le champ Titre et l'aperçu (Q-05, mesure @perf).
  const [rest, setRest] = useState(false);
  // Q-03 : le micro de l'app n'apparaît que si le plugin Speech existe (ordre 5) ; le micro du clavier iOS dicte dans le champ sans code.
  const dictation = useDictation({ layout: 'mobile', inputRef: titleRef, onText: (spoken) => setTitle(title === '' ? spoken : `${title} ${spoken}`) });
  const valid = validateTaskTitle(quick.parse.title).ok;

  // Le focus du champ Titre est posé par `Sheet` (`initialFocusRef`) dans un effet de mise en page, donc dans le geste d'ouverture
  // (Q-05 : sur iPhone, le clavier ne monte pas pour un focus posé dans une minuterie).
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  // `inert` n'est pas typé par React 18 : posé sur le DOM, comme l'écran de verrou.
  useEffect(() => {
    const element = fieldsRef.current;
    if (!element) return;
    if (waiting) element.setAttribute('inert', '');
    else element.removeAttribute('inert');
  }, [waiting]);
  useEffect(() => {
    startTransition(() => setRest(true));
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!shaking) return undefined;
    const id = window.setTimeout(() => setShaking(false), SHAKE_MS);
    return () => window.clearTimeout(id);
  }, [shaking]);

  // Entrée sur un titre vide : le champ tremble et la feuille reste ouverte (T-01). Le bouton désactivé empêche l'envoi du formulaire.
  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter' || valid) return;
    event.preventDefault();
    setShaking(true);
  }

  function changeChoice(next: DateChoice | null): void {
    const value = next ?? { date: today, time: null };
    setChoiceTouched(true);
    setOffsets((current) => offsetsAfterTimeChange(current, choice.date === null ? null : choice.time, value.date === null ? null : value.time, offsetsTouched, defaultOffsets));
    setChoice(value);
  }

  async function submit(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    // Un second Entrée pendant l'attente (chargement des dates, écriture) ne crée pas une seconde tâche.
    if (busy.current) return;
    busy.current = true;
    setNotice(null);
    try {
      await create();
    } finally {
      busy.current = false;
    }
  }

  /**
   * Lance l'écriture. Fin tardive, quelle qu'en soit l'issue, jamais muette : feuille ouverte, elle ferme la feuille ou affiche l'erreur ; feuille
   * fermée entre-temps, un message dit ce qui est arrivé à la tâche ; écriture abandonnée par « Réessayer » puis aboutie, un message prévient du doublon possible.
   */
  function startAttempt(input: Parameters<TaskCreateSheetProps['onCreate']>[0]): Attempt {
    const promise = (async (): Promise<boolean> => {
      try {
        return await onCreate(input);
      } catch {
        return false;
      }
    })();
    const attempt: Attempt = { title: input.title, abandoned: false, promise };
    pending.current = attempt;
    setWaiting(true);
    void promise.then((created) => {
      if (pending.current === attempt) pending.current = null;
      if (attempt.abandoned) {
        if (created) useNoticeStore.getState().show(t('capture.lateTwice', { title: attempt.title }));
        return;
      }
      if (!mounted.current) {
        useNoticeStore.getState().show(t(created ? 'capture.lateSaved' : 'capture.lateFailed', { title: attempt.title }));
        return;
      }
      setWaiting(false);
      if (created) onCloseRef.current();
      else setNotice('failed');
    });
    return attempt;
  }

  /** « Réessayer » : l'écriture en attente est abandonnée et une nouvelle part (le texte est figé, c'est le même). */
  function retry(): void {
    if (busy.current) return;
    const stuck = pending.current;
    if (stuck) {
      stuck.abandoned = true;
      pending.current = null;
      setWaiting(false);
    }
    void submit();
  }

  async function create(): Promise<void> {
    const parsed = await quick.parseNowLoaded();
    if (!validateTaskTitle(parsed.title).ok) return;
    // Marques explicites d'abord (Q-06 D3) ; un projet réglé à la main ne suit pas dans un autre espace.
    const finalSpaceId = parsed.spaceId ?? spaceId;
    if (!finalSpaceId) return;
    const finalProjectId = parsed.projectId ?? (parsed.spaceId !== null && parsed.spaceId !== spaceId ? null : projectId);
    // Date écrite dans le titre (Q-02), seulement si rien n'a été choisi à la main.
    const written = parsed.date !== null && !choiceTouched && !initialSomeday;
    const finalChoice: DateChoice = written ? { date: parsed.date, time: parsed.time } : choice;
    const finalOffsets = written ? offsetsAfterTimeChange(offsets, null, parsed.time, offsetsTouched, defaultOffsets) : offsets;
    const reminderOffsets = finalChoice.date === null || finalChoice.time === null ? [] : finalOffsets;
    let run = pending.current;
    if (!run) {
      const input = { title: parsed.title, spaceId: finalSpaceId, projectId: finalProjectId, choice: finalChoice, recurrence: finalChoice.date === null ? null : recurrence, icon, reminderOffsets, goalId };
      run = startAttempt(input);
    }
    // Course contre le délai de Q-05 : au-delà, « La base n'est pas prête » (l'écriture reste attendue, rien n'est perdu).
    let timer = 0;
    const slow = await Promise.race([
      run.promise.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = window.setTimeout(() => resolve(true), CREATE_NOT_READY_MS);
      }),
    ]);
    window.clearTimeout(timer);
    if (slow && mounted.current && pending.current === run) setNotice('not-ready');
  }

  return (
    <Sheet open onClose={onClose} label={t('tasks.newTask')} initialFocusRef={titleRef} className="ct-sheet--tall">
      <form className="ct-task-sheet" onSubmit={submit}>
        <div className="ct-task-sheet__header">
          <h2 className="ct-task-sheet__heading">{t('tasks.newTask')}</h2>
          <button type="button" className="ct-task-sheet__close" aria-label={t('common.close')} onClick={onClose}>
            <Icon icon={X} />
          </button>
        </div>
        <div ref={fieldsRef} className="ct-task-sheet__fields">
          {onSegmentChange && <AddSegments value="task" onChange={(segment) => onSegmentChange(segment, title)} />}
          <div className="ct-task-sheet__titleRow" data-shake={shaking ? 'true' : undefined}>
            <QuickInputField
              ref={titleRef}
              label={t('tasks.titleLabel')}
              placeholder={t('tasks.addPlaceholderPc')}
              value={title}
              onChange={(value) => {
                if (!pending.current) setTitle(value);
              }}
              readOnly={waiting}
              maxLength={TASK_TITLE_MAX_LENGTH}
              enterKeyHint="done"
              onKeyDown={handleTitleKeyDown}
              context={quick.suggestionContext}
              {...(dictation.noticeVisible ? { describedBy: dictation.helpId } : {})}
            />
            <DictationButton dictation={dictation} />
          </div>
          <DictationHelp dictation={dictation} />
          <ListeningSheet dictation={dictation} />
          <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={today} onDismiss={quick.dismiss} />
          {/* Q-05 : le bas de la feuille (icône, date, répétition, rappels, espace, objectif) se rend dans une transition, après le premier affichage :
              le champ Titre est utilisable et focalisé dans le geste, les roues et sélecteurs arrivent à l'image suivante. */}
          {rest && (
            <>
              {/* Choix Icône / Emoji (T-03, Ajout.html). */}
              <IconChooser value={icon} onChange={setIcon} />
              {/* Puces et roues jour / heure / minutes (T-14, Ajout.html). */}
              <DatePicker value={choice} today={today} onChange={changeChoice} />
              <RecurrencePicker value={recurrence} onChange={setRecurrence} startDate={choice.date ?? viewedDate} />
              {/* Rappels (N-02, Ajout.html) : grisés sans heure (QB-07) ; « À l'heure » cochée d'office à la première heure (QB-08). */}
              <ReminderBlock
                time={choice.date === null ? null : choice.time}
                offsets={offsets}
                warnFor={{ spaceId, date: choice.date }}
                onToggle={(offset) => {
                  setOffsetsTouched(true);
                  setOffsets((current) => toggleReminderOffset(current, offset));
                }}
              />
              {/* Espace puis projet (Ajout.html) : changer d'espace remet « Projet : aucun » (ES-04 critère 4). */}
              <div className="ct-task-sheet__spaceRow">
                <SpaceSegmented
                  layout="compact"
                  items={spaces}
                  value={spaceId}
                  onChange={(id) => {
                    if (id !== spaceId) setProjectId(null);
                    setSpaceId(id);
                  }}
                  label={t('detail.spaceChoiceLabel')}
                />
                <ProjectSelect spaceId={spaceId} value={projectId} onChange={setProjectId} />
              </div>
              {/* Rattacher à mon objectif (OB-03, Ajout.html) : la semaine de référence est celle de la date choisie. */}
              <GoalAttachSwitch variant="sheet" taskDate={choice.date} attachedGoalId={goalId} onChange={setGoalId} />
            </>
          )}
        </div>
        <div className="ct-task-sheet__spacer" />
        {notice && (
          <div className="ct-task-sheet__notice" role="alert">
            <span>{notice === 'not-ready' ? t('capture.sheetNotReady') : t('capture.sheetSaveError')}</span>
            {notice === 'not-ready' && (
              <button type="button" className="ct-task-sheet__retry" onClick={retry}>
                {t('capture.sheetRetry')}
              </button>
            )}
          </div>
        )}
        {/* Collé en bas de la feuille : « Enregistrer » reste visible quand le clavier réduit la fenêtre (Q-05). */}
        <div className="ct-task-sheet__footer">
          <Button type="submit" fullWidth disabled={!valid || !spaceId}>
            {t('tasks.save')}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
