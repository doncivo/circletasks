import { dismissQueueTrouble, EMPTY_ACTION_QUEUE, hasQueueTrouble, parseActionQueue, queueTrouble, type NotificationActionQueueV1 } from '../../domain/notificationActions';
import { logFailure } from '../../platform/desktop/log';
import type { AppContainer } from '../app/container';
import { statusController } from './notificationStatus';

/**
 * File locale durable des actions de notification (N-03, ADR 0012 avenant N3.4) : réglage LOCAL `notifications.actionQueue`, jamais
 * synchronisé. Accès sérialisé (deux mises à jour rapprochées ne s'écrasent jamais) ; une écriture impossible REJETTE (l'appelant n'acquitte
 * pas le fichier natif et rend l'échec visible). Une valeur illisible n'est jamais perdue en silence : file vide + `lost` = 1, visible
 * jusqu'à « Ignorer ». Le résumé (entrées en échec, écartées, perdues) est poussé au bandeau à chaque changement.
 */
export interface ActionQueueController {
  /** Lit le réglage une fois (idempotent). Ne rejette jamais. */
  load(): Promise<NotificationActionQueueV1>;
  get(): NotificationActionQueueV1;
  /** Applique `change`, écrit si la file a changé, rend la nouvelle file. Rejette si l'écriture est impossible (mémoire inchangée). */
  update(change: (current: NotificationActionQueueV1) => NotificationActionQueueV1): Promise<NotificationActionQueueV1>;
}

const controllers = new WeakMap<AppContainer, ActionQueueController>();

export function actionQueueController(container: AppContainer): ActionQueueController {
  let known = controllers.get(container);
  if (known === undefined) {
    known = createController(container);
    controllers.set(container, known);
  }
  return known;
}

function createController(container: AppContainer): ActionQueueController {
  let current: NotificationActionQueueV1 = EMPTY_ACTION_QUEUE;
  let loading: Promise<void> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const publish = (): void => statusController(container).setActions(queueTrouble(current));

  const ready = (): Promise<void> => {
    loading ??= (async () => {
      let raw: unknown = null;
      let readable = true;
      try {
        raw = await container.data.repos.settings.get('notifications.actionQueue');
      } catch {
        readable = false;
      }
      const parsed = readable ? parseActionQueue(raw) : ({ state: 'unreadable' } as const);
      if (parsed.state === 'valid') {
        current = parsed.queue;
      } else {
        logFailure('notifications', 'action-queue-unreadable');
        current = { ...EMPTY_ACTION_QUEUE, lost: 1 };
      }
      publish();
    })();
    return loading;
  };
  /** Lit le réglage une fois, puis rend TOUJOURS la file courante (jamais celle de la première lecture). */
  const load = async (): Promise<NotificationActionQueueV1> => {
    await ready();
    return current;
  };

  return {
    load,
    get: () => current,
    update: (change) => {
      const run = chain.then(async () => {
        await load();
        const next = change(current);
        if (JSON.stringify(next) !== JSON.stringify(current)) {
          await container.data.repos.settings.set('notifications.actionQueue', next);
          current = next;
        }
        publish();
        return current;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** « Ignorer » (Réglages > Rappels) : retire les entrées en échec et remet les compteurs à zéro. */
export async function dismissActionTrouble(container: AppContainer): Promise<void> {
  try {
    await actionQueueController(container).update((queue) => (hasQueueTrouble(queue) ? dismissQueueTrouble(queue) : queue));
  } catch {
    // Écriture impossible : le problème reste affiché (jamais un silence), nouvel essai au prochain geste.
    logFailure('notifications', 'action-queue-dismiss-failed');
  }
}
