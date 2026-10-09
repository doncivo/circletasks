import { CalendarDays, CalendarPlus, Sunrise } from 'lucide-react';
import { useState } from 'react';
import type { Space } from '../../domain/model';
import type { ScheduleSomedayTarget } from '../../domain/someday';
import { t } from '../../i18n';
import { ActionMenu, DatePrompt, Icon, focusNeighborLater, SelectionBar, SelectionBarButton, type ActionMenuItem } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { DeleteTaskConfirm } from '../tasks/DeleteTaskConfirm';
import { SelectionDialogs, type ListEditMode } from '../tasks/listEditMode';
import { somedayStore } from './somedayStore';
import type { SomedayView } from './useSomedayView';

/**
 * Barre « N sélectionnées » de « Un jour » (SD-04 critère 5, Main-Edition.html) : « Planifier » (à la place de « Reporter » : ces tâches
 * n'ont pas de date), « Déplacer » (espace et projet, ES-05) et « Supprimer ». Même `SelectionBar` qu'Aujourd'hui.
 */
export function SomedaySelectionBar({ edit, view }: { edit: ListEditMode; view: SomedayView }) {
  const scheduleSelected = useFeatureStore(somedayStore, (s) => s.scheduleSelected);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  if (!edit.editMode || edit.selectedIds.length === 0) return null;
  const count = edit.selectedIds.length;
  const ids = edit.selectedIds;

  const items: ActionMenuItem[] = [
    { id: 'today', label: t('someday.planToday'), icon: <Icon icon={Sunrise} size={18} /> },
    { id: 'tomorrow', label: t('someday.planTomorrow'), icon: <Icon icon={CalendarPlus} size={18} /> },
    { id: 'date', label: t('someday.planPick'), icon: <Icon icon={CalendarDays} size={18} /> },
  ];
  const plan = (target: ScheduleSomedayTarget): void => void scheduleSelected(ids, target);

  return (
    <SelectionBar label={t('today.selectionLabel')} countLabel={count === 1 ? t('today.selectedOne') : t('today.selectedMany', { count })}>
      <SelectionBarButton haspopup="dialog" expanded={edit.dialogs.moveOpen} onClick={() => edit.dialogs.setMoveOpen(true)}>
        {t('today.barMove')}
      </SelectionBarButton>
      <div className="ct-task-detail__postpone ct-task-detail__postpone--above">
        <SelectionBarButton haspopup="menu" expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>
          {t('someday.planSelection')}
        </SelectionBarButton>
        <ActionMenu
          open={menuOpen}
          label={t('someday.planSelectionMenu')}
          items={items}
          onSelect={(id) => {
            setMenuOpen(false);
            if (id === 'date') setDateOpen(true);
            else plan(id === 'tomorrow' ? 'tomorrow' : 'today');
          }}
          onClose={() => setMenuOpen(false)}
        />
        <DatePrompt
          open={dateOpen}
          label={t('someday.pickTitle')}
          confirmLabel={t('someday.pickConfirm')}
          today={view.today}
          initialValue={view.today}
          showTime
          onConfirm={(date, time) => {
            setDateOpen(false);
            if (date !== null) plan({ date, time });
          }}
          onClose={() => setDateOpen(false)}
        />
      </div>
      <SelectionBarButton danger onClick={edit.requestDeleteSelection}>
        {t('today.barDelete')}
      </SelectionBarButton>
    </SelectionBar>
  );
}

/** Fenêtres du mode édition de « Un jour » : suppression d'une ligne ou de la sélection (T-08) et déplacement d'espace ou de projet (Q12). */
export function SomedaySelectionDialogs({ edit, view, spaces }: { edit: ListEditMode; view: SomedayView; spaces: readonly Space[] }) {
  const remove = useFeatureStore(somedayStore, (s) => s.remove);
  const moveToSpace = useFeatureStore(somedayStore, (s) => s.moveToSpace);
  const target = edit.deleteTargetId ? view.tasks.find((task) => task.id === edit.deleteTargetId) : undefined;
  return (
    <>
      {target && (
        <DeleteTaskConfirm
          task={target}
          onCancel={() => edit.setDeleteTargetId(null)}
          onConfirm={() => {
            edit.setDeleteTargetId(null);
            const refocus = focusNeighborLater(target.id, true);
            void remove([target.id]).then((ok) => ok && refocus());
          }}
        />
      )}
      <SelectionDialogs
        edit={edit}
        spaces={spaces}
        onRemoveSelected={() => void remove(edit.selectedIds)}
        onMoveSelected={(spaceId, projectId) => void moveToSpace(edit.selectedIds, spaceId, projectId)}
      />
    </>
  );
}
