import type { TaskId } from '../../domain/types';
import { t } from '../../i18n';
import type { AppContainer } from '../app/container';
import { useNoticeStore } from '../app/notice';
import { focusStore } from './focusStore';

/**
 * Lance une session Focus sur une tâche (bouton de la fiche, Ctrl+Maj+F). Si une session est déjà ouverte, la fenêtre existante
 * repasse au premier plan et le message « Une session est déjà en cours » s'affiche (F-01 critère 6) ; une seule session à la fois.
 */
export async function launchFocus(container: AppContainer, taskId: TaskId): Promise<void> {
  const result = await focusStore.get(container).getState().start(taskId);
  if (result === 'busy') {
    useNoticeStore.getState().show(t('focus.alreadyRunning'));
    // PC : la mini-fenêtre est rouverte si elle avait été fermée par le système, puis ramenée devant (même appel).
    await container.focusWindow?.open(await container.data.repos.settings.get('focus.windowPosition').catch(() => null));
  } else if (result === 'error') {
    useNoticeStore.getState().show(t('focus.startError'));
  }
}
