import { Clock } from 'lucide-react';
import type { Task } from '../../domain/model';
import { t } from '../../i18n';
import { Icon } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { launchFocus } from './focusActions';
import { focusStore } from './focusStore';
import './FocusLaunchButton.css';

/**
 * Bouton « Focus » de la fiche d'une tâche (F-01 critère 1). iPhone : « Lancer un Focus » (Detail.html, 56 px) ; PC : « Focus 25 min »
 * (PC-Aujourdhui.html, 46 px), la durée étant la dernière utilisée, « Focus libre » si Libre. Absent pour une tâche terminée ou
 * supprimée.
 */
export function FocusLaunchButton({ task, isMobile }: { readonly task: Task; readonly isMobile: boolean }) {
  const container = useAppContainer();
  const duration = useFeatureStore(focusStore, (s) => s.duration);
  if (task.status !== 'todo' || task.deletedAt !== null) return null;
  const label = isMobile ? t('focus.launch') : duration === null ? t('focus.launchPcFree') : t('focus.launchPc', { min: duration });
  return (
    <button type="button" className={`ct-focus-launch ct-focus-launch--${isMobile ? 'mobile' : 'pc'}`} onClick={() => void launchFocus(container, task.id)}>
      {isMobile && <Icon icon={Clock} size={22} strokeWidth={1.8} color="var(--ct-focus-on)" />}
      {label}
    </button>
  );
}
