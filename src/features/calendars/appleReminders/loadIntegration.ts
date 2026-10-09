import { t } from '../../../i18n';
import { logFailure } from '../../../platform/desktop/log';
import { useAppStatusStore } from '../../app/appStatus';
import type { AppContainer } from '../../app/container';
import { useNavigationStore } from '../../app/navigation';
import type { RemindersIntegration } from './startReminders';

/**
 * Démarrage à la demande de l'intégration des Rappels Apple (hors du bundle de départ, jamais avant le premier rendu). Un chargement qui
 * échoue (réseau de la WebView, fichier absent) est visible : état `appleRemindersTrouble` posé (texte fixe, jamais le message d'erreur) et
 * un nouvel essai à chaque retour au premier plan ; le bandeau disparaît dès que l'intégration démarre.
 */
export interface LoadEnv {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly load: () => Promise<{ startRemindersIntegration(container: AppContainer): RemindersIntegration }>;
}

const defaultEnv = (): LoadEnv => ({ document, load: () => import('./startReminders') });

export function startRemindersLazily(container: AppContainer, env: LoadEnv = defaultEnv()): { dispose(): void } {
  let integration: RemindersIntegration | null = null;
  let loading = false;
  let stopped = false;

  const attempt = (): void => {
    if (stopped || integration !== null || loading) return;
    loading = true;
    env
      .load()
      .then(({ startRemindersIntegration }) => {
        if (stopped) return;
        integration = startRemindersIntegration(container);
        useAppStatusStore.getState().setStatus('appleRemindersTrouble', null);
      })
      .catch(() => {
        logFailure('apple-reminders', 'start-load-failed');
        if (stopped) return;
        useAppStatusStore.getState().setStatus('appleRemindersTrouble', {
          detail: 'start-load-failed',
          message: t('appleReminders.bannerLoad'),
          onAction: () => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'calendars' }),
        });
      })
      .finally(() => {
        loading = false;
      });
  };
  const onVisibility = (): void => {
    if (env.document.visibilityState !== 'hidden') attempt();
  };
  env.document.addEventListener('visibilitychange', onVisibility);
  attempt();
  return {
    dispose: () => {
      stopped = true;
      env.document.removeEventListener('visibilitychange', onVisibility);
      integration?.dispose();
      integration = null;
    },
  };
}
