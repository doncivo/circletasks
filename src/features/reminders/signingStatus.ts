import { createStore } from 'zustand';
import { EMPTY_SIGNING_STATUS, parseSigningStatus, type SigningStatusV1 } from '../../domain/signingNotice';
import { logFailure } from '../../platform/desktop/log';
import { defineFeatureStore, type AppContainer } from '../app/container';

/**
 * État persistant de l'alerte d'expiration (I-02, ADR 0013 §3.3) : réglage LOCAL `notifications.signing`, jamais synchronisé, distinct de
 * `notifications.status`. Lu une fois ; écrit à chaque changement ; si l'écriture est impossible, l'état reste dans le store pour la session
 * (visible) et l'écriture est retentée au changement suivant. Un réglage illisible est journalisé (`signing-status-unreadable`) et lu vide.
 */

export interface SigningStatusState {
  readonly status: SigningStatusV1;
  readonly loaded: boolean;
  /** Dernière écriture du réglage impossible : l'état n'est que dans la mémoire de cette session. */
  readonly persistFailed: boolean;
}

export const signingStatusStore = defineFeatureStore<SigningStatusState>(() =>
  createStore<SigningStatusState>()(() => ({ status: EMPTY_SIGNING_STATUS, loaded: false, persistFailed: false })),
);

export interface SigningStatusController {
  /** Lit le réglage une fois (idempotent). Ne rejette jamais. */
  load(): Promise<void>;
  get(): SigningStatusV1;
  /** Remplace l'état par `change(état)`, l'écrit s'il a changé. Ne rejette jamais. */
  patch(change: (current: SigningStatusV1) => SigningStatusV1): Promise<void>;
}

const controllers = new WeakMap<AppContainer, SigningStatusController>();

export function signingStatusController(container: AppContainer): SigningStatusController {
  let known = controllers.get(container);
  if (known === undefined) {
    known = createController(container);
    controllers.set(container, known);
  }
  return known;
}

function createController(container: AppContainer): SigningStatusController {
  const store = signingStatusStore.get(container);
  let loading: Promise<void> | null = null;
  // Les écritures se suivent : deux patchs rapprochés ne s'écrasent jamais.
  let chain: Promise<void> = Promise.resolve();

  const load = (): Promise<void> => {
    loading ??= (async () => {
      let raw: unknown;
      try {
        raw = await container.data.repos.settings.get('notifications.signing');
      } catch {
        logFailure('signing', 'signing-status-unreadable');
        store.setState({ status: EMPTY_SIGNING_STATUS, loaded: true });
        return;
      }
      const parsed = parseSigningStatus(raw);
      if (parsed.unreadable) logFailure('signing', 'signing-status-unreadable');
      store.setState({ status: parsed.status, loaded: true });
    })();
    return loading;
  };

  return {
    load,
    get: () => store.getState().status,
    patch: (change) => {
      const run = chain.then(async () => {
        await load();
        const before = store.getState().status;
        const next = change(before);
        if (JSON.stringify(next) === JSON.stringify(before) && !store.getState().persistFailed) return;
        store.setState({ status: next });
        try {
          await container.data.repos.settings.set('notifications.signing', next);
          store.setState({ persistFailed: false });
        } catch {
          store.setState({ persistFailed: true });
          logFailure('signing', 'signing-status-write-failed');
        }
      });
      chain = run;
      return run;
    },
  };
}
