import { setActionWakeHandler } from './actionWake';
import { clearReminderBanner, statusController } from './notificationStatus';
import { getNotificationRunner } from './notificationRunner';
import type { AppContainer } from '../app/container';

/** Tables synchronisées dont une modification reçue change le plan (avenant N1.3) : réglages = récapitulatifs et langue. */
export const SYNC_PLAN_TABLES = ['task', 'routine', 'routine_pause', 'routine_log', 'event', 'reminder', 'space', 'settings'] as const;

export interface NotificationsIntegration {
  /** Se résout à la fin du passage `open` (tests : aucune attente par délai). */
  opened(): Promise<unknown>;
  dispose(): void;
}

export interface NotificationsEnv {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

/**
 * Branche les déclencheurs de replanification (N-01 critère 8, N-05) : `open` (APRÈS le premier rendu : l'appelant la monte dans un effet,
 * jamais attendue par le rendu), `resume` et `hide` (visibilité, comme T-11), `sync` (`onRemoteChanges`), `edit` (écritures validées,
 * `container.onNotificationsPlanChanged`). Le fuseau (`zone`) arrive par `timeZoneWatcher.onChange` (startup.ts). Les passages se
 * suivent un à un (`notificationRunner`). Sur le PC le passage ne fait rien : l'envoi est sur l'iPhone.
 */
export function startNotificationIntegration(container: AppContainer, env: NotificationsEnv = { document }): NotificationsIntegration {
  const runner = getNotificationRunner(container);
  let disposed = false;
  const request = (trigger: Parameters<typeof runner.request>[0]): void => {
    if (!disposed) void runner.request(trigger);
  };

  // N-03 : le plugin d'actions réveille l'app quand il écrit une ligne (course entre `didReceive` et le `drain` de la reprise) ; inscrit au premier passage.
  const stopWake = setActionWakeHandler(container, () => request('action'));
  const stopEdit = container.onNotificationsPlanChanged(() => request('edit'));
  const stopSync = container.sync?.onRemoteChanges((change) => {
    if (SYNC_PLAN_TABLES.some((table) => change.tables.has(table))) request('sync');
  });
  const onVisibility = (): void => request(env.document.visibilityState === 'hidden' ? 'hide' : 'resume');
  env.document.addEventListener('visibilitychange', onVisibility);

  // Le bandeau persistant est posé dès la lecture de l'état enregistré, avant la fin du premier passage.
  void statusController(container).load();
  const opened = runner.request('open');
  return {
    opened: () => opened,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopEdit();
      stopWake();
      stopSync?.();
      env.document.removeEventListener('visibilitychange', onVisibility);
      clearReminderBanner();
    },
  };
}
