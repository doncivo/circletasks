import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { todayLocal } from '../../domain/clock';
import { t } from '../../i18n';
import { DetailPanel, Sheet, useDetailSlot, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { TaskDetailBody } from './TaskDetailBody';
import { taskDetailStore } from './taskDetailStore';
import type { TaskDetailApi } from './useTaskDetailEdits';
import './TaskDetail.css';

/**
 * Fiche détail d'une tâche (A-08) : panneau à droite sur PC, feuille quasi plein écran sur iPhone (`useLayout`, ADR 0004). Le
 * panneau PC se loge dans l'emplacement de la coquille (pleine hauteur, contre le bord droit) quand elle en fournit un.
 *
 * La tâche affichée est lue dans `container.taskEntities` (source unique, ADR 0004).
 */
export function TaskDetail() {
  const detail = useNavigationStore((s) => s.detail);
  const closeDetail = useNavigationStore((s) => s.closeDetail);
  const layout = useLayout();
  const slot = useDetailSlot();

  const taskId = detail?.type === 'task' ? detail.id : null;
  // Tâche lue dans la source unique (ADR 0004, avenant) : toute écriture, d'où qu'elle vienne (liste, annulation), est reflétée ici.
  const entities = useTaskEntities();
  const task = taskId ? entities.get(taskId) : undefined;
  const status = useFeatureStore(taskDetailStore, (s) => s.status);
  const errorKey = useFeatureStore(taskDetailStore, (s) => s.errorKey);
  const reminders = useFeatureStore(taskDetailStore, (s) => s.reminders);
  const goalTitle = useFeatureStore(taskDetailStore, (s) => s.goalTitle);
  const recurrence = useFeatureStore(taskDetailStore, (s) => s.recurrence);
  const load = useFeatureStore(taskDetailStore, (s) => s.load);
  const remove = useFeatureStore(taskDetailStore, (s) => s.remove);
  const duplicate = useFeatureStore(taskDetailStore, (s) => s.duplicate);
  const refreshRecurrence = useFeatureStore(taskDetailStore, (s) => s.refreshRecurrence);
  const updateNote = useFeatureStore(taskDetailStore, (s) => s.updateNote);
  const updateIcon = useFeatureStore(taskDetailStore, (s) => s.updateIcon);
  const updateFields = useFeatureStore(taskDetailStore, (s) => s.updateFields);
  const applySeriesEdit = useFeatureStore(taskDetailStore, (s) => s.applySeriesEdit);
  const setRecurrence = useFeatureStore(taskDetailStore, (s) => s.setRecurrence);
  const updateRecurrence = useFeatureStore(taskDetailStore, (s) => s.updateRecurrence);
  const stopRecurrence = useFeatureStore(taskDetailStore, (s) => s.stopRecurrence);
  const setReminders = useFeatureStore(taskDetailStore, (s) => s.setReminders);
  const postpone = useFeatureStore(taskDetailStore, (s) => s.postpone);
  const postponeSeries = useFeatureStore(taskDetailStore, (s) => s.postponeSeries);
  const toggleDone = useFeatureStore(taskDetailStore, (s) => s.toggleDone);
  const moveToSomeday = useFeatureStore(taskDetailStore, (s) => s.moveToSomeday);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  // T-10 critère 8 : « Annuler » (message ou Ctrl+Z) d'une modification de règle ne touche pas la tâche ; la règle affichée est relue.
  const { undo, clock } = useAppContainer();
  const undoSnapshot = useSyncExternalStore(undo.subscribe, undo.getSnapshot);
  const recurrenceId = task?.recurrenceId ?? null;
  useEffect(() => {
    if (recurrenceId !== null) void refreshRecurrence();
  }, [recurrenceId, undoSnapshot, refreshRecurrence]);

  // Note non enregistrée (perte de focus pas encore survenue) : la fiche la sauvegarde aussi à la fermeture, y compris par Échap, qui
  // ne déclenche pas de `blur`. `useTaskDetailEdits` tient la référence à jour à chaque rendu.
  const flushNoteRef = useRef<() => boolean>(() => false);
  /** Saisie en place en cours (titre, date, heure, espace) : annule et rend true ; null si aucune. */
  const cancelInlineRef = useRef<(() => boolean) | null>(null);

  useEffect(() => {
    if (taskId) void load(taskId);
  }, [taskId, load]);

  const api: TaskDetailApi = useMemo(
    () => ({ updateNote, updateIcon, updateFields, applySeriesEdit, setRecurrence, updateRecurrence, stopRecurrence, postpone, postponeSeries, toggleDone, moveToSomeday, setReminders }),
    [updateNote, updateIcon, updateFields, applySeriesEdit, setRecurrence, updateRecurrence, stopRecurrence, postpone, postponeSeries, toggleDone, moveToSomeday, setReminders],
  );

  if (!taskId) return null;

  function handleClose(): void {
    // Échap pendant une saisie en place : annule la saisie sans fermer la fiche (A-08 critère 8).
    if (cancelInlineRef.current?.()) return;
    // Note modifiée sur une occurrence récurrente : la question « cette occurrence / toutes les suivantes » s'affiche, la fiche reste ouverte.
    if (flushNoteRef.current()) return;
    closeDetail();
  }

  // La tâche affichée (`task.id`) sert de clé à `TaskDetailBody` : changer de tâche remonte un composant frais plutôt que de
  // synchroniser brouillons et sélecteurs par effet.
  const content = task ? (
    <TaskDetailBody
      key={task.id}
      task={task}
      api={api}
      flushNoteRef={flushNoteRef}
      cancelInlineRef={cancelInlineRef}
      spaces={spaces}
      today={appDay ?? todayLocal(clock)}
      nowMs={clock.nowMs()}
      reminders={reminders}
      goalTitle={goalTitle}
      recurrence={recurrence}
      isMobile={layout === 'mobile'}
      onClose={handleClose}
      duplicate={duplicate}
      // Suppression confirmée (T-08) : la tâche part dans la corbeille et la fiche se ferme. `scope` : occurrence d'une série (T-10).
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
    const panel = (
      <DetailPanel label={t('tasks.detailLabel')} onClose={handleClose} width={588}>
        {content}
      </DetailPanel>
    );
    return slot ? createPortal(panel, slot) : panel;
  }

  return (
    <Sheet open onClose={handleClose} label={t('tasks.detailLabel')} className="ct-sheet--tall">
      {content}
    </Sheet>
  );
}
