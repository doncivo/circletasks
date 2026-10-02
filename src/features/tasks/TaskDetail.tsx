import { Check, Copy, Pencil, X } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { todayLocal } from '../../domain/clock';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, Space, Task, TaskPatch } from '../../domain/model';
import type { LocalDate } from '../../domain/types';
import { RULE_EDIT_SCOPES, ruleChanged, scopeChoicesForEdit, type SeriesScope } from '../../domain/recurrenceEdit';
import { recurrenceLabel } from '../../domain/recurrenceLabel';
import type { PostponeTarget } from '../../domain/taskPostpone';
import type { PlainMessageKey } from '../../i18n';
import { t } from '../../i18n';
import { formatMessageRef } from '../../i18n/formatRecurrence';
import { formatStamp } from '../../i18n/format';
import { Button, ChoiceDialog, DetailPanel, Icon, IconChooser, IconView, RecurrencePicker, Sheet, TextField, resolveIconRefColor, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { DeleteTaskConfirm } from './DeleteTaskConfirm';
import { DuplicatePrompt } from './DuplicatePrompt';
import { PostponeAction } from './PostponeAction';
import { TaskDetailFields } from './TaskDetailFields';
import { TaskEditSheet, type EditSheetResult } from './TaskEditSheet';
import { taskDetailStore } from './taskDetailStore';
import './TaskDetail.css';

/**
 * Fiche détail d'une tâche (A-08), limitée par T-03 aux zones icône et note : la
 * fiche complète (date, récurrence, rappels, espace, projet, objectif, boutons
 * Focus / Reporter / Un jour / Dupliquer / Supprimer) arrive avec A-08. Panneau à
 * droite sur PC, feuille plein écran sur iPhone (`useLayout`, ADR 0004).
 *
 * La tâche affichée est lue dans `container.taskEntities` (source unique, ADR 0004).
 */
export function TaskDetail() {
  const detail = useNavigationStore((s) => s.detail);
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const layout = useLayout();

  const taskId = detail?.type === 'task' ? detail.id : null;
  // Tâche lue dans la source unique (ADR 0004, avenant) : toute écriture, d'où qu'elle
  // vienne (liste, annulation), est reflétée ici sans copie à synchroniser.
  const entities = useTaskEntities();
  const task = taskId ? entities.get(taskId) : undefined;
  const status = useFeatureStore(taskDetailStore, (s) => s.status);
  const errorKey = useFeatureStore(taskDetailStore, (s) => s.errorKey);
  const load = useFeatureStore(taskDetailStore, (s) => s.load);
  const reminders = useFeatureStore(taskDetailStore, (s) => s.reminders);
  const goalTitle = useFeatureStore(taskDetailStore, (s) => s.goalTitle);
  const updateFields = useFeatureStore(taskDetailStore, (s) => s.updateFields);
  const moveToSomeday = useFeatureStore(taskDetailStore, (s) => s.moveToSomeday);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const updateNote = useFeatureStore(taskDetailStore, (s) => s.updateNote);
  const updateIcon = useFeatureStore(taskDetailStore, (s) => s.updateIcon);
  const toggleDone = useFeatureStore(taskDetailStore, (s) => s.toggleDone);
  const postpone = useFeatureStore(taskDetailStore, (s) => s.postpone);
  const postponeSeries = useFeatureStore(taskDetailStore, (s) => s.postponeSeries);
  const remove = useFeatureStore(taskDetailStore, (s) => s.remove);
  const duplicate = useFeatureStore(taskDetailStore, (s) => s.duplicate);
  const recurrence = useFeatureStore(taskDetailStore, (s) => s.recurrence);
  const setRecurrence = useFeatureStore(taskDetailStore, (s) => s.setRecurrence);
  const applySeriesEdit = useFeatureStore(taskDetailStore, (s) => s.applySeriesEdit);
  const updateRecurrence = useFeatureStore(taskDetailStore, (s) => s.updateRecurrence);
  const stopRecurrence = useFeatureStore(taskDetailStore, (s) => s.stopRecurrence);
  const refreshRecurrence = useFeatureStore(taskDetailStore, (s) => s.refreshRecurrence);
  // T-10 critère 8 : « Annuler » (message ou Ctrl+Z) d'une modification de règle ne touche pas la tâche ; la règle affichée est relue.
  const { undo, clock } = useAppContainer();
  const undoSnapshot = useSyncExternalStore(undo.subscribe, undo.getSnapshot);
  const recurrenceId = task?.recurrenceId ?? null;
  useEffect(() => {
    if (recurrenceId !== null) void refreshRecurrence();
  }, [recurrenceId, undoSnapshot, refreshRecurrence]);

  // Note non enregistrée (perte de focus pas encore survenue) : la fiche la
  // sauvegarde aussi à la fermeture (critère 8), y compris par Échap, qui ne
  // déclenche pas de `blur` sur le champ. `TaskDetailBody` tient la référence à
  // jour à chaque rendu (pas un effet : simple affectation, pas un `setState`).
  const flushNoteRef = useRef<() => boolean>(() => false);
  /** Saisie en place en cours (titre, heure) : annule et rend true ; null si aucune. */
  const cancelInlineRef = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  if (!taskId) return null;

  function handleClose(): void {
    // Échap pendant une saisie en place (titre, heure) : annule la saisie sans fermer la fiche (A-08 critère 8).
    if (cancelInlineRef.current?.()) return;
    // Note modifiée sur une occurrence récurrente : la question « cette occurrence / toutes les suivantes » s'affiche, la fiche reste ouverte.
    if (flushNoteRef.current()) return;
    closeDetail();
  }

  // La tâche affichée (`task?.id`) sert de clé à `TaskDetailBody` : changer de
  // tâche remonte un composant frais plutôt que de synchroniser le brouillon de
  // note et l'état du sélecteur d'icône par effet (pas de setState dans un effet).
  const content =
    task ? (
      <TaskDetailBody
        key={task.id}
        task={task}
        flushNoteRef={flushNoteRef}
        cancelInlineRef={cancelInlineRef}
        spaces={spaces}
        today={appDay ?? todayLocal(clock)}
        nowMs={clock.nowMs()}
        reminders={reminders}
        goalTitle={goalTitle}
        updateFields={updateFields}
        moveToSomeday={moveToSomeday}
        onClose={handleClose}
        showCloseButton={layout === 'mobile'}
        updateNote={updateNote}
        updateIcon={updateIcon}
        toggleDone={toggleDone}
        postpone={postpone}
        postponeSeries={postponeSeries}
        duplicate={duplicate}
        recurrence={recurrence}
        setRecurrence={setRecurrence}
        applySeriesEdit={applySeriesEdit}
        updateRecurrence={updateRecurrence}
        stopRecurrence={stopRecurrence}
        // Suppression confirmée (T-08, critère 2) : la tâche part dans la corbeille, la fiche se ferme
        // (sans réécrire la note : la tâche n'existe plus ; la perte de focus l'a déjà enregistrée).
        // `scope` : occurrence d'une série (T-10 critère 7).
        onDelete={async (scope) => {
          if (await remove(scope)) closeDetail();
        }}
        errorKey={status === 'error' ? errorKey : null}
      />
    ) : status === 'error' && errorKey ? (
      <p role="alert" className="ct-task-detail__error">
        {t(errorKey)}
      </p>
    ) : null;

  if (layout === 'pc') {
    return (
      <DetailPanel label={t('tasks.detailLabel')} onClose={handleClose} width={588}>
        {content}
      </DetailPanel>
    );
  }

  return (
    <Sheet open onClose={handleClose} label={t('tasks.detailLabel')}>
      {content}
    </Sheet>
  );
}

interface TaskDetailBodyProps {
  task: Task;
  /** Enregistre la note en attente ; rend true si une question (T-10) doit être posée avant de fermer. */
  flushNoteRef: React.MutableRefObject<() => boolean>;
  cancelInlineRef: React.MutableRefObject<(() => boolean) | null>;
  spaces: readonly Space[];
  today: LocalDate;
  /** Instant courant (horodatage relatif « modifiée hier à 18:04 »). */
  nowMs: number;
  reminders: readonly ReminderOffsetMin[];
  goalTitle: string | null;
  /** A-08 critère 8 : modifie des champs de la tâche (titre, date, heure, espace). Rend true si écrit. */
  updateFields: (patch: TaskPatch) => Promise<boolean>;
  /** Bouton « Un jour » (SD-03). */
  moveToSomeday: () => Promise<boolean>;
  onClose: () => void;
  /** Feuille iPhone : `Sheet` ne porte pas de bouton de fermeture intégré (contrairement à `DetailPanel`, PC). */
  showCloseButton: boolean;
  updateNote: (note: string) => Promise<void>;
  updateIcon: (icon: IconRef | null) => Promise<void>;
  /** Bouton « Marquer comme terminée » / « Rouvrir » (T-04, Detail.html). */
  toggleDone: () => Promise<void>;
  /** « Reporter » / « Planifier » (T-05). */
  postpone: (target: PostponeTarget) => Promise<void>;
  /** T-10 : report d'une occurrence récurrente pour « cette occurrence » ou « toutes les suivantes ». */
  postponeSeries: (target: PostponeTarget, scope: SeriesScope) => Promise<void>;
  /** T-12 : « Dupliquer » ; la copie est créée à `date` (null : « Un jour »), la fiche reste sur l'original. */
  duplicate: (date: LocalDate | null) => Promise<boolean>;
  /** Règle de la série (T-09), `null` : tâche non récurrente. */
  recurrence: RecurrenceFields | null;
  /** « Répéter… » : pose une règle sur une tâche datée (T-09) ; la modification / l'arrêt relèvent de T-10. */
  setRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  /** T-10 : applique une modification à « cette occurrence » ou « toutes les suivantes ». */
  applySeriesEdit: (patch: TaskPatch, scope: SeriesScope) => Promise<boolean>;
  /** T-10 : nouvelle règle pour « toutes les suivantes ». */
  updateRecurrence: (rule: RecurrenceFields) => Promise<boolean>;
  /** T-10 : « Arrêter la répétition ». */
  stopRecurrence: () => Promise<boolean>;
  /** Suppression confirmée (T-08) ; la fiche parente se ferme si elle réussit. `scope` : T-10. */
  onDelete: (scope?: SeriesScope) => Promise<void>;
  /** Échec d'enregistrement ou de report à afficher (la tâche reste affichée). */
  errorKey: PlainMessageKey | null;
}

/** Contenu de la fiche pour une tâche donnée ; remonté (par `key`) à chaque changement de tâche. */
function TaskDetailBody({ task, flushNoteRef, cancelInlineRef, spaces, today, nowMs, reminders, goalTitle, updateFields, moveToSomeday, onClose, showCloseButton, updateNote, updateIcon, toggleDone, postpone, postponeSeries, duplicate, recurrence, setRecurrence, applySeriesEdit, updateRecurrence, stopRecurrence, onDelete, errorKey }: TaskDetailBodyProps) {
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [repeatDraft, setRepeatDraft] = useState<RecurrenceFields | null>(null);
  const [noteDraft, setNoteDraft] = useState(task.note);
  // La note change hors de la zone de saisie (« Annuler » d'une modification, T-10 critère 8) : le champ la suit.
  const [seenNote, setSeenNote] = useState(task.note);
  if (task.note !== seenNote) {
    setSeenNote(task.note);
    setNoteDraft(task.note);
  }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // T-10 : modification en attente du choix « cette occurrence / toutes les suivantes ».
  const [pendingEdit, setPendingEdit] = useState<TaskPatch | null>(null);
  const [ruleEditOpen, setRuleEditOpen] = useState(false);
  /** `undefined` : règle non touchée ; `null` : « Une fois » choisi (arrêt). */
  const [ruleDraft, setRuleDraft] = useState<RecurrenceFields | null | undefined>(undefined);
  const [ruleScopeOpen, setRuleScopeOpen] = useState(false);
  /** Report d'une occurrence récurrente en attente du choix de portée (T-10 critère 4). */
  const [pendingPostpone, setPendingPostpone] = useState<PostponeTarget | null>(null);
  /** Note en cours d'écriture après le choix : la perte de focus qui suit ne repose pas la question. */
  const savingNote = useRef<string | null>(null);

  /** La modification d'une occurrence récurrente passe par la question ; rend true si elle est posée. */
  function askScope(patch: TaskPatch): boolean {
    if (scopeChoicesForEdit(task, patch).length === 0) return false;
    setPendingEdit(patch);
    return true;
  }

  /** Enregistre la note si elle a changé ; rend true si la question de portée est posée (la fiche ne doit pas se fermer). */
  function flushNote(): boolean {
    if (noteDraft === task.note || savingNote.current === noteDraft) return false;
    if (askScope({ note: noteDraft })) return true;
    void updateNote(noteDraft);
    return false;
  }

  function chooseScope(scope: SeriesScope): void {
    const patch = pendingEdit;
    setPendingEdit(null);
    if (!patch) return;
    savingNote.current = patch.note ?? null;
    void applySeriesEdit(patch, scope).then((ok) => {
      savingNote.current = null;
      if (!ok && patch.note !== undefined) setNoteDraft(task.note);
    });
  }

  function cancelScope(): void {
    if (pendingEdit?.note !== undefined) setNoteDraft(task.note);
    setPendingEdit(null);
  }

  function applyRuleDraft(): void {
    setRuleScopeOpen(false);
    if (ruleDraft === undefined || (ruleDraft !== null && recurrence && !ruleChanged(recurrence, ruleDraft))) {
      setRuleEditOpen(false);
      return;
    }
    // « Une fois » : arrêt de la répétition ; sinon « toutes les suivantes » seulement (T-10 critère 4).
    const done = ruleDraft === null ? stopRecurrence() : updateRecurrence(ruleDraft);
    void done.then((ok) => {
      if (ok) setRuleEditOpen(false);
    });
  }

  // Tient la référence du parent à jour après chaque rendu (pas de tableau de
  // dépendances) : `handleClose` appelle toujours la dernière version de
  // `flushNote`, sans provoquer de rendu supplémentaire (mutation de ref, pas
  // `setState`).
  useEffect(() => {
    flushNoteRef.current = flushNote;
  });

  const isMobile = showCloseButton;
  const [editOpen, setEditOpen] = useState(false);
  /** Feuille « Modifier la tâche » enregistrée sur une occurrence récurrente : en attente du choix de portée. */
  const [pendingSheet, setPendingSheet] = useState<EditSheetResult | null>(null);
  const [localErrorKey, setLocalErrorKey] = useState<PlainMessageKey | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);

  // Échap pendant la saisie du titre : annule la saisie, la fiche reste ouverte.
  useEffect(() => {
    if (!editingTitle) return undefined;
    const cancel = (): boolean => {
      setEditingTitle(false);
      return true;
    };
    cancelInlineRef.current = cancel;
    return () => {
      if (cancelInlineRef.current === cancel) cancelInlineRef.current = null;
    };
  }, [editingTitle, cancelInlineRef]);

  /** Modification d'un champ (A-08 critère 8) : question de portée pour une occurrence récurrente, sinon écriture immédiate. */
  function commitPatch(patch: TaskPatch): void {
    setLocalErrorKey(null);
    if (task.recurrenceId !== null && patch.someday === true) {
      setLocalErrorKey('tasks.seriesError'); // une occurrence garde une date (T-09 critère 5)
      return;
    }
    if (!askScope(patch)) void updateFields(patch);
  }

  function startTitleEdit(): void {
    setTitleDraft(task.title);
    setEditingTitle(true);
  }

  function commitTitle(): void {
    setEditingTitle(false);
    if (titleDraft.trim() !== task.title) commitPatch({ title: titleDraft });
  }

  async function applySheet(result: EditSheetResult, scope?: SeriesScope): Promise<void> {
    if (Object.keys(result.patch).length > 0) {
      const ok = scope ? await applySeriesEdit(result.patch, scope) : await updateFields(result.patch);
      if (!ok) return;
    }
    if (result.rule === undefined) return;
    if (task.recurrenceId === null) {
      if (result.rule) await setRecurrence(result.rule);
    } else if (result.rule === null) await stopRecurrence();
    else await updateRecurrence(result.rule);
  }

  function saveSheet(result: EditSheetResult): void {
    setEditOpen(false);
    setLocalErrorKey(null);
    if (task.recurrenceId !== null && result.patch.someday === true) {
      setLocalErrorKey('tasks.seriesError');
      return;
    }
    if (scopeChoicesForEdit(task, result.patch).length > 0) setPendingSheet(result);
    else void applySheet(result);
  }

  function chooseIcon(icon: IconRef | null): void {
    if (!askScope({ icon })) void updateIcon(icon);
    setPickerOpen(false);
  }

  const repeatNode = (
    <>
      {/* Répétition (Detail.html : « Répétition  Mensuelle, le 23 »). Résumé en lecture seule pour une
          tâche récurrente ; « Répéter… » pour une tâche datée, non terminée, sans règle (T-09). */}
      {task.recurrenceId !== null ? (
        recurrence && (
          <div className="ct-task-detail__repeat">
            <div className="ct-task-detail__row">
              <span>{t('tasks.repeatLabel')}</span>
              <span className="ct-task-detail__rowValue" data-testid="recurrence-detail">
                {formatMessageRef(recurrenceLabel(recurrence, task.date))}
              </span>
            </div>
            {task.status !== 'done' ? (
              <>
                <Button
                  variant="secondary"
                  expanded={ruleEditOpen}
                  ariaLabel={t('tasks.repeatEditLabel')}
                  onClick={() => {
                    setRuleDraft(undefined);
                    setRuleEditOpen((open) => !open);
                  }}
                >
                  {t('tasks.repeatEdit')}
                </Button>
                <Button variant="secondary" onClick={() => void stopRecurrence()}>
                  {t('tasks.repeatStop')}
                </Button>
                {ruleEditOpen ? (
                  <div className="ct-task-detail__iconEditor">
                    <RecurrencePicker value={ruleDraft === undefined ? recurrence : ruleDraft} onChange={setRuleDraft} startDate={task.date} />
                    <Button disabled={ruleDraft === undefined} onClick={() => (ruleDraft === null ? applyRuleDraft() : setRuleScopeOpen(true))}>
                      {t('tasks.repeatApply')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        )
      ) : (
        task.date !== null &&
        task.status !== 'done' && (
          <div className="ct-task-detail__repeat">
            <div className="ct-task-detail__row">
              <span>{t('tasks.repeatLabel')}</span>
              <span className="ct-task-detail__rowValue" data-testid="recurrence-detail">
                {t('tasks.repeatOnce')}
              </span>
            </div>
            <Button
              variant="secondary"
              expanded={repeatOpen}
              ariaLabel={t('tasks.repeatActionLabel')}
              onClick={() => {
                setRepeatDraft(null);
                setRepeatOpen((open) => !open);
              }}
            >
              {t('tasks.repeatAction')}
            </Button>
            {repeatOpen && (
              <div className="ct-task-detail__iconEditor">
                <RecurrencePicker value={repeatDraft} onChange={setRepeatDraft} startDate={task.date} />
                <Button
                  disabled={repeatDraft === null}
                  onClick={() => {
                    if (!repeatDraft) return;
                    void setRecurrence(repeatDraft).then((ok) => {
                      if (ok) setRepeatOpen(false);
                    });
                  }}
                >
                  {t('tasks.repeatApply')}
                </Button>
              </div>
            )}
          </div>
        )
      )}

    </>
  );

  return (
    <div className="ct-task-detail">
      {isMobile && (
        <div className="ct-task-detail__topRow">
          <button type="button" className="ct-task-detail__edit" onClick={() => setEditOpen(true)}>
            <Icon icon={Pencil} size={20} />
            {t('detail.edit')}
          </button>
          <button type="button" className="ct-task-detail__close" aria-label={t('common.close')} onClick={onClose}>
            <Icon icon={X} />
          </button>
        </div>
      )}
      <div className="ct-task-detail__header">
        <button
          type="button"
          className="ct-task-detail__iconButton"
          aria-label={task.icon ? t('tasks.changeIcon') : t('tasks.iconFieldLabel')}
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
        >
          {task.icon ? (
            <IconView icon={task.icon} size={28} color={resolveIconRefColor(task.icon)} />
          ) : (
            <span className="ct-task-detail__iconPlaceholder" aria-hidden="true" />
          )}
        </button>
        {editingTitle ? (
          <form
            className="ct-task-detail__titleField"
            onSubmit={(event) => {
              event.preventDefault();
              commitTitle();
            }}
          >
            <TextField label={t('detail.titleLabel')} value={titleDraft} onChange={setTitleDraft} onBlur={commitTitle} maxLength={200} autoFocus />
          </form>
        ) : (
          <h2
            className={isMobile ? 'ct-task-detail__title' : 'ct-task-detail__title ct-task-detail__title--editable'}
            {...(isMobile
              ? {}
              : {
                  tabIndex: 0,
                  'aria-description': t('detail.titleEditHint'),
                  onClick: startTitleEdit,
                  onKeyDown: (event: KeyboardEvent<HTMLHeadingElement>) => {
                    if (event.key === 'Enter' || event.key === 'F2') {
                      event.preventDefault();
                      startTitleEdit();
                    }
                  },
                })}
          >
            {task.title}
          </h2>
        )}
      </div>

      {/* « Marquer comme terminée » (T-04, Detail.html) : libellé constant, l'état est porté
          par `aria-pressed` seul ; la ligne appelante reflète la tâche via `taskEntities`. */}
      <Button
        variant="secondary"
        pressed={task.status === 'done'}
        onClick={() => void toggleDone()}
        className="ct-task-detail__doneButton"
      >
        <Icon icon={Check} size={18} />
        {t('tasks.markDone')}
      </Button>


      {errorKey && (
        <p role="alert" className="ct-task-detail__error">
          {t(errorKey)}
        </p>
      )}

      {pickerOpen && (
        <div className="ct-task-detail__iconEditor">
          <IconChooser value={task.icon} onChange={chooseIcon} />
          {task.icon && (
            <Button variant="secondary" onClick={() => chooseIcon(null)}>
              {t('tasks.removeIcon')}
            </Button>
          )}
        </div>
      )}

      <TaskDetailFields
        task={task}
        layout={isMobile ? 'mobile' : 'pc'}
        spaces={spaces}
        today={today}
        reminders={reminders}
        goalTitle={goalTitle}
        onPatch={commitPatch}
        cancelInlineRef={cancelInlineRef}
        repeat={repeatNode}
      />

      <TextField
        label={t('tasks.noteLabel')}
        visibleLabel
        multiline
        value={noteDraft}
        onChange={setNoteDraft}
        onBlur={flushNote}
        className="ct-task-detail__note"
      />
      <p className="ct-task-detail__stamp">{t('detail.createdModified', { created: formatStamp(task.createdAt, nowMs), modified: formatStamp(task.updatedAt, nowMs) })}</p>

      <div className="ct-task-detail__actions">
        <PostponeAction task={task} onPostpone={task.recurrenceId !== null ? async (target) => setPendingPostpone(target) : postpone} />
        {/* « Un jour » (SD-03) : une tâche à faire, non récurrente (une occurrence garde une date) ; Focus (M10) : absent tant que M10 n'existe pas. */}
        {task.status === 'todo' && !task.someday && task.recurrenceId === null && (
          <Button variant="secondary" onClick={() => void moveToSomeday()} className="ct-task-detail__somedayButton">
            {t('detail.somedayAction')}
          </Button>
        )}
        {/* « Dupliquer » (T-12, Detail.html ; PC : ajouté pour A-08, écart documenté) : possible aussi sur une tâche terminée. */}
        <Button variant="secondary" ariaLabel={t('tasks.duplicateLabel')} onClick={() => setDuplicateOpen(true)} className="ct-task-detail__duplicateButton">
          <Icon icon={Copy} size={18} />
          {t('tasks.duplicate')}
        </Button>
      </div>
      {duplicateOpen && (
        <DuplicatePrompt
          task={task}
          onClose={() => setDuplicateOpen(false)}
          onConfirm={(date) => {
            setDuplicateOpen(false);
            void duplicate(date);
          }}
        />
      )}
      {localErrorKey && (
        <p role="alert" className="ct-task-detail__error">
          {t(localErrorKey)}
        </p>
      )}

      {isMobile && editOpen && (
        <TaskEditSheet task={task} spaces={spaces} today={today} recurrence={recurrence} onClose={() => setEditOpen(false)} onSave={saveSheet} />
      )}
      {pendingSheet ? (
        <ChoiceDialog
          title={t('tasks.seriesEditTitle', { title: task.title })}
          description={t('tasks.seriesEditBody')}
          options={[
            { id: 'occurrence', label: t('tasks.seriesScopeOccurrence') },
            { id: 'following', label: t('tasks.seriesScopeFollowing') },
          ]}
          onChoose={(scope) => {
            const result = pendingSheet;
            setPendingSheet(null);
            void applySheet(result, scope);
          }}
          onCancel={() => setPendingSheet(null)}
        />
      ) : null}
      {pendingEdit ? (
        <ChoiceDialog
          title={t('tasks.seriesEditTitle', { title: task.title })}
          description={t('tasks.seriesEditBody')}
          options={[
            { id: 'occurrence', label: t('tasks.seriesScopeOccurrence') },
            { id: 'following', label: t('tasks.seriesScopeFollowing') },
          ]}
          onChoose={chooseScope}
          onCancel={cancelScope}
        />
      ) : null}
      {pendingPostpone ? (
        <ChoiceDialog
          title={t('tasks.seriesPostponeTitle', { title: task.title })}
          description={t('tasks.seriesPostponeBody')}
          options={[
            { id: 'occurrence', label: t('tasks.seriesScopeOccurrence') },
            { id: 'following', label: t('tasks.seriesScopeFollowing') },
          ]}
          onChoose={(scope) => {
            const target = pendingPostpone;
            setPendingPostpone(null);
            void postponeSeries(target, scope);
          }}
          onCancel={() => setPendingPostpone(null)}
        />
      ) : null}
      {ruleScopeOpen ? (
        <ChoiceDialog
          title={t('tasks.seriesRuleTitle')}
          description={t('tasks.seriesRuleBody')}
          options={RULE_EDIT_SCOPES.map((id) => ({ id, label: t('tasks.seriesScopeFollowing') }))}
          onChoose={applyRuleDraft}
          onCancel={() => setRuleScopeOpen(false)}
        />
      ) : null}

      {/* « Supprimer la tâche » (iPhone) / « Supprimer » (PC) : texte rouge, confirmation puis corbeille (T-08). */}
      <button type="button" className="ct-task-detail__delete" onClick={() => setConfirmOpen(true)}>
        {t(showCloseButton ? 'tasks.deleteTask' : 'tasks.deleteTaskPc')}
      </button>
      {confirmOpen && (
        <DeleteTaskConfirm
          task={task}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={(scope) => {
            setConfirmOpen(false);
            void onDelete(scope);
          }}
        />
      )}
    </div>
  );
}
