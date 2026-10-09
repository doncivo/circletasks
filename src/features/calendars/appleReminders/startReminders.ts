import type { AppContainer } from '../../app/container';
import { logFailure } from '../../../platform/desktop/log';
import { appleRemindersState, clearBanner } from './appleRemindersState';
import { getRemindersRunner, type RemindersTrigger } from './remindersRunner';

/**
 * Branche les déclencheurs des passages Rappels Apple (K-05 critère 11, ADR 0008 §10.8) : `open` (APRÈS le premier rendu : l'appelant la monte
 * dans un effet, jamais attendue par le rendu), `resume` et `hide` (visibilité), `changed` (événement EventKit du plugin), `sync` (tâches ou
 * réglages reçus), `edit` (écriture locale : passage `push` après l'annulation de 5 s). Les passages se suivent un à un
 * (`remindersRunner`). Sur le PC aucun passage et aucun appel de plugin : seuls les réglages sont lus (écran en lecture seule, K-07) et relus
 * quand la synchro apporte des réglages ou des tâches.
 */
export interface RemindersIntegration {
  /** Se résout à la fin du passage `open` (tests : aucune attente par délai). */
  opened(): Promise<unknown>;
  dispose(): void;
}

export interface RemindersEnv {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export function startRemindersIntegration(container: AppContainer, env: RemindersEnv = { document }): RemindersIntegration {
  const state = appleRemindersState(container);
  let disposed = false;
  // Réglages et état persistant lus aussitôt : le bandeau survit à un redémarrage et le PC affiche ce que la synchro a apporté.
  const loaded = state.load();

  const stopSync = container.sync?.onRemoteChanges((change) => {
    if (change.tables.has('settings') || change.tables.has('task')) {
      if (container.reminders.available) {
        if (!disposed) void getRemindersRunner(container).request('sync');
      } else if (change.tables.has('settings')) {
        void state.reload();
      }
    }
  });

  if (!container.reminders.available) {
    return {
      opened: () => loaded,
      dispose: () => {
        disposed = true;
        stopSync?.();
      },
    };
  }

  const runner = getRemindersRunner(container);
  const request = (trigger: RemindersTrigger): Promise<unknown> => (disposed ? Promise.resolve() : runner.request(trigger));
  const onVisibility = (): void => void request(env.document.visibilityState === 'hidden' ? 'hide' : 'resume');
  env.document.addEventListener('visibilitychange', onVisibility);
  const stopEdit = container.onNotificationsPlanChanged(() => void request('edit'));
  let stopChanged: (() => void) | null = null;
  void container.reminders.onChanged(() => void request('changed')).then(
    (stop) => {
      if (disposed) stop();
      else stopChanged = stop;
    },
    // Écoute impossible : message dans l'écran Agendas (et journal), les passages à l'ouverture et à la reprise continuent.
    () => {
      logFailure('apple-reminders', 'listener-failed');
      void state.addNotice({ kind: 'listener-failed', count: 1 });
    },
  );
  const opened = loaded.then(() => request('open'));
  return {
    opened: () => opened,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopEdit();
      stopSync?.();
      stopChanged?.();
      env.document.removeEventListener('visibilitychange', onVisibility);
      runner.dispose();
      clearBanner();
    },
  };
}
