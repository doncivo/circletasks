import { useMemo } from 'react';
import type { Space } from '../../domain/model';
import type { TodayList } from '../../domain/todayList';
import type { PostponeTarget } from '../../domain/taskPostpone';
import { t } from '../../i18n';
import { SelectionBar, SelectionBarButton } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { SelectionDialogs, useListEditMode, type ListEditMode } from '../tasks/listEditMode';
import { PostponeAction } from '../tasks/PostponeAction';
import { todayStore } from './todayStore';

/**
 * Mode édition d'Aujourd'hui (A-05) : l'état vient de `todayStore`, la logique de sélection, de suppression et de déplacement est
 * celle, commune, de `useListEditMode` (partagée avec « Un jour », SD-04). Le mode n'est pas mémorisé : il se coupe en quittant l'écran.
 */
export type TodayEditMode = ListEditMode;

export function useTodayEditMode(list: TodayList): TodayEditMode {
  const editMode = useFeatureStore(todayStore, (s) => s.editMode);
  const selection = useFeatureStore(todayStore, (s) => s.selection);
  const setEditMode = useFeatureStore(todayStore, (s) => s.setEditMode);
  const toggleSelection = useFeatureStore(todayStore, (s) => s.toggleSelection);
  const addToSelection = useFeatureStore(todayStore, (s) => s.addToSelection);
  // Tâches affichées dans l'ordre de la liste (Maj+clic : intervalle).
  const visibleTaskIds = useMemo(() => [...list.rows, ...list.doneRows].flatMap((row) => (row.kind === 'task' ? [row.task.id] : [])), [list]);
  return useListEditMode({ editMode, selection, setEditMode, toggleSelection, addToSelection }, visibleTaskIds);
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
  return <SelectionDialogs edit={edit} spaces={spaces} onRemoveSelected={() => void removeSelected()} onMoveSelected={(spaceId, projectId) => void moveSelected(spaceId, projectId)} />;
}
