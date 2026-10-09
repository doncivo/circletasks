import { isRestoreQuiet, trackQuietWork } from '../../platform/quiet';
import type { AppContainer } from '../app/container';
import { calendarsStore } from './calendarsStore';

/**
 * Planificateur du rafraîchissement des agendas (K-03, ADR 0008) : à l'ouverture de l'app (critère 1), au retour au premier plan
 * (critère 1), puis toutes les 15 min au premier plan (critère 2, D3). Les RÈGLES (15 min depuis la dernière réussite, pas
 * d'arrière-plan, pas de nouvelle tentative après un 401, délai d'un 429, verrou par compte) sont `shouldRefresh` du domaine ;
 * ce module ne fait que les déclencher. Le minuteur sonde toutes les 30 s : la décision, pas la fréquence de sondage, fixe
 * l'échéance, et elle reste exacte même si l'ordinateur sort de veille. Horloge, minuteur et premier plan sont injectables : aucun
 * `sleep` réel dans les tests.
 */

/** Période de sondage du minuteur (l'échéance de 15 min est décidée par `shouldRefresh`). */
export const POLL_INTERVAL_MS = 30_000;

export interface SchedulerEnv {
  readonly document: Pick<Document, 'visibilityState'>;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface CalendarScheduler {
  /** Premier rafraîchissement d'ouverture terminé (ne rejette jamais). */
  readonly ready: Promise<void>;
  /** Sonde une fois, comme le ferait le minuteur (tests). */
  tick(): Promise<void>;
  /** Retour au premier plan ou focus de la fenêtre (appelé par `startAppStartup`) : lecture si la dernière réussite date de plus de 15 min. */
  resume(): Promise<void>;
  /** Arrête minuteur et écouteurs, retire les états A-09 posés par les agendas ; idempotent. */
  dispose(): void;
}

export function startCalendarScheduler(container: AppContainer, env: SchedulerEnv = { document }): CalendarScheduler {
  const store = calendarsStore.get(container);
  const setTimer = env.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearTimer = env.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const foreground = (): boolean => env.document.visibilityState !== 'hidden';
  let disposed = false;

  const run = async (trigger: 'open' | 'resume' | 'tick'): Promise<void> => {
    // P-04-iOS (revue I3) : aucun rafraîchissement pendant la mise au calme d'une restauration ; un rafraîchissement en cours est attendu.
    if (disposed || isRestoreQuiet()) return;
    try {
      await trackQuietWork(store.getState().refreshAll(trigger, foreground()));
    } catch {
      // `refreshAll` ne rejette pas ; une exception inattendue ne doit jamais arrêter le planificateur.
    }
  };

  const timer = setTimer(() => void run('tick'), POLL_INTERVAL_MS);

  // Ouverture : comptes lus, états recalculés (secret absent : « à reconnecter »), puis lecture immédiate de chacun.
  const ready = store
    .getState()
    .load()
    .then(() => run('open'))
    .catch(() => undefined);

  return {
    ready,
    tick: () => run('tick'),
    resume: () => (foreground() ? run('resume') : Promise.resolve()),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer(timer);
      store.getState().releaseStatuses();
    },
  };
}
