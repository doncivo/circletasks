import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { Space } from '../../domain/model';
import { moveDestinations } from '../../domain/spaceMove';
import type { TodayList } from '../../domain/todayList';
import type { PostponeTarget } from '../../domain/taskPostpone';
import type { ProjectId, SpaceId, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { ChoiceDialog, ConfirmDialog, SelectionBar, SelectionBarButton } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { isModalOpen } from '../app/tabShortcuts';
import { PostponeAction } from '../tasks/PostponeAction';
import { todayStore } from './todayStore';

/**
 * Mode édition d'Aujourd'hui (A-05) : sélection multiple, suppression d'une ligne ou de la sélection, déplacement d'espace,
 * report par lot, Échap, Ctrl+clic et Maj+clic. Le mode n'est pas mémorisé : il se coupe en quittant l'écran.
 */
export interface TodayEditMode {
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

export function useTodayEditMode(list: TodayList): TodayEditMode {
  const container = useAppContainer();
  const editMode = useFeatureStore(todayStore, (s) => s.editMode);
  const selection = useFeatureStore(todayStore, (s) => s.selection);
  const setEditMode = useFeatureStore(todayStore, (s) => s.setEditMode);
  const toggleSelection = useFeatureStore(todayStore, (s) => s.toggleSelection);
  const addToSelection = useFeatureStore(todayStore, (s) => s.addToSelection);
  const [deleteTargetId, setDeleteTargetId] = useState<TaskId | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const anchorRef = useRef<TaskId | null>(null);

  // Tâches affichées dans l'ordre de la liste (Maj+clic : intervalle).
  const visibleTaskIds = useMemo(() => [...list.rows, ...list.doneRows].flatMap((row) => (row.kind === 'task' ? [row.task.id] : [])), [list]);
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

/** Barre « N sélectionnées » (Déplacer, Reporter, Supprimer) au-dessus du champ d'ajout. */
export function TodaySelectionBar({ edit }: { edit: TodayEditMode }) {
  const postponeSelected = useFeatureStore(todayStore, (s) => s.postponeSelected);
  if (!edit.editMode || edit.selectedIds.length === 0) return null;
  const count = edit.selectedIds.length;
  return (
    <SelectionBar label={t('today.selectionLabel')} countLabel={count === 1 ? t('today.selectedOne') : t('today.selectedMany', { count })}>
      <SelectionBarButton haspopup="dialog" expanded={edit.dialogs.moveOpen} onClick={() => edit.dialogs.setMoveOpen(true)}>
        {t('today.barMove')}
      </SelectionBarButton>
      <PostponeAction
        menuAbove
        menuLabel={t('today.postponeSelectionMenu')}
        onPostpone={(target: PostponeTarget) => postponeSelected(target)}
        trigger={({ expanded, toggle }) => (
          <SelectionBarButton haspopup="menu" expanded={expanded} onClick={toggle}>
            {t('today.barPostpone')}
          </SelectionBarButton>
        )}
      />
      <SelectionBarButton danger onClick={edit.requestDeleteSelection}>
        {t('today.barDelete')}
      </SelectionBarButton>
    </SelectionBar>
  );
}

/** Fenêtres du mode édition : « Supprimer N tâches ? » et « Déplacer vers un espace ou un projet » (Q12, ES-05). */
export function TodaySelectionDialogs({ edit, spaces }: { edit: TodayEditMode; spaces: readonly Space[] }) {
  const removeSelected = useFeatureStore(todayStore, (s) => s.removeSelected);
  const moveSelected = useFeatureStore(todayStore, (s) => s.moveSelected);
  const { batchDeleteOpen, setBatchDeleteOpen, moveOpen, setMoveOpen } = edit.dialogs;
  const projects = useAppStore((s) => s.projects);
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
          description={t('today.deleteManyBody')}
          confirmLabel={t('tasks.deleteConfirm')}
          onConfirm={() => {
            setBatchDeleteOpen(false);
            void removeSelected();
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
            void moveSelected(spaceId as SpaceId, projectId === '' ? null : (projectId as ProjectId));
          }}
          onCancel={() => setMoveOpen(false)}
        />
      )}
    </>
  );
}
