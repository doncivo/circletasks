import type { AppContainer } from '../app/container';
import { updaterStore } from './updaterStore';

/** Première vérification après le lancement (critère 1 : dans les 10 s). */
export const LAUNCH_CHECK_DELAY_MS = 5_000;
/** Cadence de vérification en fonctionnement (D-03 : toutes les 24 h). */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Nouvelle tentative après un échec (réseau absent) : sans attendre 24 h, sans harceler. */
export const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;
/** Pas de la minuterie qui compare l'horloge à l'échéance (robuste à la veille du PC). */
export const POLL_INTERVAL_MS = 60_000;

/** Minuteries injectables (tests). */
export interface UpdateTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number): void;
}

const browserTimers: UpdateTimers = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => window.clearTimeout(id),
  setInterval: (handler, ms) => window.setInterval(handler, ms),
  clearInterval: (id) => window.clearInterval(id),
};

export interface UpdateChecks {
  /** Compare l'horloge du conteneur à la prochaine échéance et vérifie si elle est atteinte. */
  tick(): Promise<void>;
  /** Arrête les minuteries ; idempotent. */
  dispose(): void;
}

/**
 * Planification des vérifications de mise à jour (D-03, critère 1) : une vérification
 * au lancement (après 5 s), puis une toutes les 24 h tant que l'app tourne. L'échéance est
 * comparée à l'horloge injectée (`container.clock`), pas au nombre de ticks : un PC qui
 * sort de veille vérifie dès le tick suivant. Sans intégration PC, ne planifie rien.
 */
export function startUpdateChecks(container: AppContainer, timers: UpdateTimers = browserTimers): UpdateChecks {
  if (!container.desktop) return { tick: () => Promise.resolve(), dispose: () => undefined };

  const store = updaterStore.get(container);
  let nextCheckAt = container.clock.nowMs() + LAUNCH_CHECK_DELAY_MS;
  let running = false;
  let disposed = false;

  const tick = async (): Promise<void> => {
    if (disposed || running || container.clock.nowMs() < nextCheckAt) return;
    running = true;
    try {
      const result = await store.getState().check();
      nextCheckAt = container.clock.nowMs() + (result === 'ok' ? CHECK_INTERVAL_MS : RETRY_AFTER_FAILURE_MS);
    } finally {
      running = false;
    }
  };

  const launch = timers.setTimeout(() => void tick(), LAUNCH_CHECK_DELAY_MS);
  const poll = timers.setInterval(() => void tick(), POLL_INTERVAL_MS);
  return {
    tick,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      timers.clearTimeout(launch);
      timers.clearInterval(poll);
    },
  };
}
