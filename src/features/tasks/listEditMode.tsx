import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Space } from '../../domain/model';
import { moveDestinations } from '../../domain/spaceMove';
import type { ProjectId, SpaceId, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { ChoiceDialog, ConfirmDialog } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { isModalOpen } from '../app/tabShortcuts';

/**
 * Mode édition d'une liste de tâches (A-05, Main-Edition.html), commun à Aujourd'hui et à « Un jour » (SD-04 critère 5) : sélection
 * multiple, suppression d'une ligne ou de la sélection, déplacement d'espace ou de projet, Échap, Ctrl+clic et Maj+clic. Le mode n'est
 * pas mémorisé : il se coupe en quittant l'écran. L'état vient du store de l'écran (`ListEditSource`), les actions de la barre
 * (report, planification, suppression, déplacement) aussi : ce module ne connaît ni l'un ni l'autre.
 */
export interface ListEditMode {
  readonly editMode: boolean;
  readonly setEditMode: (active: boolean) => void;
  readonly selection: ReadonlySet<TaskId>;
  /** Sélection encore affichée (une tâche reportée, supprimée ou déplacée hors de la vue n'en fait plus partie). */
  readonly selectedIds: readonly TaskId[];
  /** Tâche dont la suppression est demandée (« − » d'une ligne, ou sélection d'une seule tâche) : confirmation T-08 / T-10. */
  readonly deleteTargetId: TaskId | null;
  readonly setDeleteTargetId: (id: TaskId | null) => void;
  /** Supprimer la sélection : une tâche seule suit T-08, plusieurs demandent « Supprimer N tâches ? ». */
  readonly requestDeleteSelection: () => void;
  /** Coche ou décoche une ligne et la retient comme point de départ de Maj+clic. */
  readonly toggle: (id: TaskId) => void;
  /** Ctrl+clic : bascule ; Maj+clic : intervalle depuis la dernière ligne cochée (PC, critère 10). Rend true si le clic est consommé. */
  readonly onRowClick: (event: MouseEvent<HTMLElement>, id: TaskId) => boolean;
  readonly dialogs: {
    readonly batchDeleteOpen: boolean;
    readonly setBatchDeleteOpen: (open: boolean) => void;
    readonly moveOpen: boolean;
    readonly setMoveOpen: (open: boolean) => void;
  };
}

/** État du mode édition tenu par le store de l'écran. */
export interface ListEditSource {
  readonly editMode: boolean;
  readonly selection: ReadonlySet<TaskId>;
  readonly setEditMode: (active: boolean) => void;
  readonly toggleSelection: (id: TaskId) => void;
  readonly addToSelection: (ids: readonly TaskId[]) => void;
}

/** `visibleTaskIds` : tâches affichées dans l'ordre de la liste (Maj+clic : intervalle) ; à mémoïser par l'appelant. */
export function useListEditMode(source: ListEditSource, visibleTaskIds: readonly TaskId[]): ListEditMode {
  const container = useAppContainer();
  const { editMode, selection, setEditMode, toggleSelection, addToSelection } = source;
  const [deleteTargetId, setDeleteTargetId] = useState<TaskId | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const anchorRef = useRef<TaskId | null>(null);

  const selectedIds = useMemo(() => visibleTaskIds.filter((id) => selection.has(id)), [visibleTaskIds, selection]);

  // Le mode édition n'est pas mémorisé : il se coupe en quittant l'écran (changement d'onglet, redémarrage).
  useEffect(() => () => setEditMode(false), [setEditMode]);

  // Échap quitte le mode édition (PC) ; les fenêtres et panneaux gardent leur propre Échap.
  useEffect(() => {
    if (!editMode) return undefined;
    return container.shortcuts.register('app.escape', () => {
      if (!isModalOpen()) setEditMode(false);
    });
  }, [container, editMode, setEditMode]);

  function requestDeleteSelection(): void {
    const [only] = selectedIds;
    if (selectedIds.length === 1 && only) setDeleteTargetId(only);
    else if (selectedIds.length > 1) setBatchDeleteOpen(true);
  }

  function toggle(id: TaskId): void {
    anchorRef.current = id;
    toggleSelection(id);
  }

  function onRowClick(event: MouseEvent<HTMLElement>, id: TaskId): boolean {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) return false;
    event.preventDefault();
    event.stopPropagation();
    const anchor = anchorRef.current;
    const from = anchor ? visibleTaskIds.indexOf(anchor) : -1;
    const to = visibleTaskIds.indexOf(id);
    if (event.shiftKey && from >= 0 && to >= 0) addToSelection(visibleTaskIds.slice(Math.min(from, to), Math.max(from, to) + 1));
    else toggleSelection(id);
    anchorRef.current = id;
    return true;
  }

  return {
    editMode,
    setEditMode,
    selection,
    selectedIds,
    deleteTargetId,
    setDeleteTargetId,
    requestDeleteSelection,
    toggle,
    onRowClick,
    dialogs: { batchDeleteOpen, setBatchDeleteOpen, moveOpen, setMoveOpen },
  };
}

export interface SelectionDialogsProps {
  readonly edit: ListEditMode;
  readonly spaces: readonly Space[];
  /** Suppression de la sélection confirmée (corbeille, annulable). */
  readonly onRemoveSelected: () => void;
  /** Déplacement de la sélection vers un espace et un projet (Q12, ES-05), sans changer la date. */
  readonly onMoveSelected: (spaceId: SpaceId, projectId: ProjectId | null) => void;
}

/** Fenêtres du mode édition : « Supprimer N tâches ? » et « Déplacer vers un espace ou un projet » (Q12, ES-05). */
export function SelectionDialogs({ edit, spaces, onRemoveSelected, onMoveSelected }: SelectionDialogsProps) {
  const { batchDeleteOpen, setBatchDeleteOpen, moveOpen, setMoveOpen } = edit.dialogs;
  const projects = useAppStore((s) => s.projects);
  const container = useAppContainer();
  // K-06 critère 7 : la confirmation nomme Rappels quand la sélection contient des tâches liées à un rappel (supprimé aussi dans Rappels).
  const linkedCount = batchDeleteOpen
    ? edit.selectedIds.filter((id) => {
        const task = container.taskEntities.get(id);
        return task !== undefined && task.source === 'apple_reminders' && task.externalId !== null;
      }).length
    : 0;
  // Q12 : une liste d'une pression, « Perso · aucun projet » puis « Pro · Mission client »… (espace, puis projet ou aucun).
  const destinations = moveDestinations(spaces, projects).map((target) => {
    const space = spaces.find((s) => s.id === target.spaceId)?.name ?? '';
    const project = target.projectId ? projects.find((p) => p.id === target.projectId)?.name : undefined;
    return { id: `${target.spaceId}|${target.projectId ?? ''}`, label: project ? t('today.moveToProject', { space, project }) : t('today.moveNoProject', { space }) };
  });
  return (
    <>
      {batchDeleteOpen && (
        <ConfirmDialog
          title={t('today.deleteManyTitle', { count: edit.selectedIds.length })}
          description={linkedCount > 0 ? `${t('today.deleteManyBody')} ${t('appleReminders.deleteManyLinked', { count: linkedCount })}` : t('today.deleteManyBody')}
          confirmLabel={t('tasks.deleteConfirm')}
          onConfirm={() => {
            setBatchDeleteOpen(false);
            onRemoveSelected();
          }}
          onCancel={() => setBatchDeleteOpen(false)}
        />
      )}
      {moveOpen && (
        <ChoiceDialog
          title={t('today.moveTitle')}
          description={t('today.moveBody')}
          options={destinations}
          onChoose={(id) => {
            const [spaceId = '', projectId = ''] = id.split('|');
            setMoveOpen(false);
            onMoveSelected(spaceId as SpaceId, projectId === '' ? null : (projectId as ProjectId));
          }}
          onCancel={() => setMoveOpen(false)}
        />
      )}
    </>
  );
}
