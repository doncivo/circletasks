import type { RawNotificationAction } from '../../domain/notificationActions';
import { NotificationActionSourceError, type ActionDrain, type ActionTypeSpec, type NotificationActionSource } from './actions';

/**
 * Faux de la source d'actions (N-03) : joue le fichier natif en mémoire. `push` = le plugin Swift écrit une ligne (app tuée, appui sur
 * « Fait »), `drain` la rend sans l'effacer, `ack` la retire ; un test peut couper entre l'écriture de la file et `ack` (`failNextAck`)
 * ou faire échouer chaque commande. Jamais importé par le code de l'app hors du résolveur de développement (`__ctNotificationActions`).
 */
export interface FakeNotificationActionSource extends NotificationActionSource {
  /** Lignes du fichier natif, dans l'ordre. */
  readonly file: RawNotificationAction[];
  /** Appels reçus, dans l'ordre : `registerActionTypes`, `drain`, `ack:{lines}`, `status`. */
  readonly calls: string[];
  /** Catégories reçues au dernier `registerActionTypes`. */
  registered: readonly ActionTypeSpec[];
  /** Écrit une ligne dans le fichier et réveille les écouteurs (le plugin émet `action` après chaque ligne). */
  push(action: RawNotificationAction, options?: { readonly wake?: boolean }): void;
  /** Ajoute des lignes illisibles ou des écritures impossibles vues par le natif. */
  addUnreadable(count: number): void;
  addWriteFailures(count: number): void;
  setDelegate(value: boolean): void;
  /** Le délégué n'était pas posé à la fin du lancement (A2). */
  setDelegateAtLaunch(value: boolean): void;
  /** La prochaine commande de ce nom échoue (consommée par l'appel). */
  failNext(command: 'registerActionTypes' | 'drain' | 'ack' | 'status'): void;
}

export function createFakeNotificationActionSource(): FakeNotificationActionSource {
  const file: RawNotificationAction[] = [];
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  let unreadable = 0;
  let writeFailures = 0;
  let delegate = true;
  let delegateAtLaunch = true;
  const failing = new Set<string>();

  const maybeFail = (command: string): void => {
    if (failing.delete(command)) throw new NotificationActionSourceError('rejected');
  };

  const source: FakeNotificationActionSource = {
    file,
    calls,
    registered: [],
    push: (action, options) => {
      file.push(action);
      if (options?.wake !== false) for (const listener of [...listeners]) listener();
    },
    addUnreadable: (count) => {
      unreadable += count;
    },
    addWriteFailures: (count) => {
      writeFailures += count;
    },
    setDelegate: (value) => {
      delegate = value;
    },
    setDelegateAtLaunch: (value) => {
      delegateAtLaunch = value;
    },
    failNext: (command) => {
      failing.add(command);
    },
    registerActionTypes: (types) => {
      calls.push('registerActionTypes');
      try {
        maybeFail('registerActionTypes');
      } catch (error) {
        return Promise.reject(error as Error);
      }
      source.registered = types;
      return Promise.resolve();
    },
    drain: (): Promise<ActionDrain> => {
      calls.push('drain');
      try {
        maybeFail('drain');
      } catch (error) {
        return Promise.reject(error as Error);
      }
      return Promise.resolve({ entries: [...file], lines: file.length + unreadable, unreadable, writeFailures });
    },
    ack: ({ lines, writeFailures: failures }) => {
      calls.push(`ack:${String(lines)}`);
      try {
        maybeFail('ack');
      } catch (error) {
        return Promise.reject(error as Error);
      }
      // Les lignes illisibles sont retirées d'abord (elles étaient en tête dans ce faux), puis les lignes lisibles.
      const fromUnreadable = Math.min(unreadable, lines);
      unreadable -= fromUnreadable;
      file.splice(0, lines - fromUnreadable);
      writeFailures = Math.max(0, writeFailures - failures);
      return Promise.resolve();
    },
    status: () => {
      calls.push('status');
      try {
        maybeFail('status');
      } catch (error) {
        return Promise.reject(error as Error);
      }
      return Promise.resolve({ delegate, delegateAtLaunch, categories: source.registered.length });
    },
    onWake: (listener) => {
      listeners.add(listener);
      return Promise.resolve(() => {
        listeners.delete(listener);
      });
    },
  };
  return source;
}
