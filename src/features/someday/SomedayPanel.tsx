import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../i18n';
import { CompactToggle, EditModeSwitch, Icon, SomedayIcon, useDelayedFlag, useDetailSlot } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { isModalOpen } from '../app/tabShortcuts';
import { useNavigationStore } from '../app/navigation';
import { SomedayAddField } from './SomedayAddField';
import { SomedayList } from './SomedayList';
import { SomedaySelectionBar, SomedaySelectionDialogs } from './SomedaySelectionBar';
import { useSomedayListState } from './useSomedayListState';
import { useSomedayView } from './useSomedayView';
import './SomedayScreen.css';

export interface SomedayPanelProps {
  /** « Fermer le panneau » ou Échap. */
  readonly onClose: () => void;
  /** Logé dans l'emplacement du panneau de détail de la coquille (à droite d'Aujourd'hui) ; sinon rendu sur place (Semaine, S-06). */
  readonly slot?: boolean;
}

/**
 * Panneau « Un jour » du PC (PC-Semaine-UnJour.html : 300 px, fond #FAF9FC, icône horloge #5B43A8, titre Fraunces, cartes, « + Ajouter à
 * « Un jour » »). À droite d'Aujourd'hui (SD-01 critère 2) ou de la Semaine (S-06). Échap ou « Fermer le panneau » le ferme.
 */
export function SomedayPanel({ onClose, slot = false }: SomedayPanelProps) {
  const container = useAppContainer();
  const view = useSomedayView();
  const state = useSomedayListState(view);
  const detail = useNavigationStore((s) => s.detail);
  const hostSlot = useDetailSlot();
  const [adding, setAdding] = useState(false);
  const showSkeleton = useDelayedFlag(view.status === 'loading', 150);

  // Échap ferme le panneau, sauf sous une fenêtre ou une feuille modale (elles ont leur propre Échap).
  useEffect(
    () =>
      container.shortcuts.register('app.escape', () => {
        if (!isModalOpen()) onClose();
      }),
    [container, onClose],
  );

  const panel = (
    <aside className="ct-someday-panel" aria-label={t('someday.panelLabel')}>
      <div className="ct-someday-panel__header">
        <SomedayIcon size={28} color="var(--ct-color-someday)" />
        <h2 className="ct-someday-panel__title">{t('someday.title')}</h2>
        <CompactToggle active={state.compact} onChange={state.setCompact} label={t('today.compactView')} />
        <button type="button" className="ct-someday__iconButton" aria-label={t('someday.closePanel')} onClick={onClose}>
          <Icon icon={X} size={20} />
        </button>
      </div>
      <span className="ct-someday-panel__help">{view.subtitle}</span>
      {view.errorKey && view.status === 'error' && (
        <p className="ct-someday__error" role="alert">
          {t(view.errorKey)}
        </p>
      )}
      {view.actionErrorKey && (
        <p className="ct-someday__error" role="alert">
          {t(view.actionErrorKey)}
        </p>
      )}
      <SomedayList view={view} state={state} openedTaskId={detail?.type === 'task' ? detail.id : null} showSkeleton={showSkeleton} />
      <SomedaySelectionBar edit={state.edit} view={view} />
      <div className="ct-someday-panel__spacer" />
      <div className="ct-someday-panel__footer">
        <EditModeSwitch active={state.edit.editMode} onChange={state.edit.setEditMode} label={t('today.editMode')} />
        {adding ? (
          <SomedayAddField onAdd={view.addInline} autoFocus onCollapse={() => setAdding(false)} className="ct-someday-panel__field" />
        ) : (
          <button type="button" className="ct-someday-panel__add" onClick={() => setAdding(true)}>
            {t('someday.addButton')}
          </button>
        )}
      </div>
      <SomedaySelectionDialogs edit={state.edit} view={view} spaces={view.spaces} />
    </aside>
  );
  return slot && hostSlot ? createPortal(panel, hostSlot) : panel;
}
