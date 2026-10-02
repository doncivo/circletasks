import { useEffect, useState, type ReactNode } from 'react';
import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { ChoiceDialog } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { DuplicatePrompt } from '../tasks';
import { DeleteTaskConfirm } from '../tasks/DeleteTaskConfirm';
import { todayStore } from './todayStore';
import type { TodayEditMode } from './useTodayEditMode';

export interface TodayRowActions {
  /** Ligne « sélectionnée » au clavier : la dernière ayant reçu le focus (case, titre ou poignée). */
  readonly focusedTaskId: TaskId | null;
  readonly setFocusedTaskId: (id: TaskId) => void;
  /** Fenêtres ouvertes par les raccourcis et le « − » : report d'une série, copie, suppression. */
  readonly dialogs: ReactNode;
}

/**
 * Raccourcis de la ligne sélectionnée (registre de raccourcis) : Espace (terminer ; en mode édition, sélectionner), Ctrl+D (demain),
 * Suppr, Ctrl+Maj+D (dupliquer), et leurs fenêtres de confirmation (T-05, T-08, T-10, T-12).
 */
export function useTodayRowActions(edit: TodayEditMode): TodayRowActions {
  const container = useAppContainer();
  const entities = useTaskEntities();
  const toggleDone = useFeatureStore(todayStore, (s) => s.toggleDone);
  const postpone = useFeatureStore(todayStore, (s) => s.postpone);
  const postponeSeries = useFeatureStore(todayStore, (s) => s.postponeSeries);
  const remove = useFeatureStore(todayStore, (s) => s.remove);
  const duplicate = useFeatureStore(todayStore, (s) => s.duplicate);
  const [focusedTaskId, setFocusedTaskId] = useState<TaskId | null>(null);
  const [postponeSeriesId, setPostponeSeriesId] = useState<TaskId | null>(null);
  const [duplicateTargetId, setDuplicateTargetId] = useState<TaskId | null>(null);
  const { editMode, selectedIds, toggle, requestDeleteSelection, deleteTargetId, setDeleteTargetId } = edit;

  useEffect(() => {
    if (!focusedTaskId) return undefined;
    // Mode édition : la case « Terminer » est remplacée par le rond de sélection, Espace sélectionne.
    return container.shortcuts.register('list.complete', () => (editMode ? toggle(focusedTaskId) : void toggleDone(focusedTaskId)));
  }, [container, focusedTaskId, toggleDone, toggle, editMode]);

  // Ctrl+D (T-05) : reporte à demain ; une occurrence récurrente pose d'abord « Cette occurrence / Toutes les suivantes » (T-10).
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.postponeTomorrow', () => {
      const task = container.taskEntities.get(focusedTaskId);
      if (task?.recurrenceId && task.status === 'todo') setPostponeSeriesId(focusedTaskId);
      else void postpone(focusedTaskId, 'tomorrow');
    });
  }, [container, focusedTaskId, postpone]);

  // Suppr (T-08) : confirmation d'abord ; en mode édition avec une sélection, c'est la sélection qui est supprimée (A-05).
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.delete', () => {
      if (editMode && selectedIds.length > 0) requestDeleteSelection();
      else if (container.taskEntities.get(focusedTaskId)) setDeleteTargetId(focusedTaskId);
    });
  }, [container, focusedTaskId, editMode, selectedIds, requestDeleteSelection, setDeleteTargetId]);

  // Ctrl+Maj+D (T-12) : choix de la date de la copie, présélectionnée sur la date de l'original.
  useEffect(() => {
    if (!focusedTaskId) return undefined;
    return container.shortcuts.register('list.duplicate', () => {
      if (container.taskEntities.get(focusedTaskId)) setDuplicateTargetId(focusedTaskId);
    });
  }, [container, focusedTaskId]);

  const postponeSeriesTask = postponeSeriesId ? entities.get(postponeSeriesId) : undefined;
  const duplicateTarget = duplicateTargetId ? entities.get(duplicateTargetId) : undefined;
  const deleteTarget = deleteTargetId ? entities.get(deleteTargetId) : undefined;

  const dialogs = (
    <>
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
    </>
  );

  return { focusedTaskId, setFocusedTaskId, dialogs };
}
