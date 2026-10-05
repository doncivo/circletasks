import type { Clock } from '../domain/clock';
import { QUIT_SYNC_BUDGET_MS, SYNC_INTERVAL_MS } from '../domain/sync/limits';
import type { SyncReason, SyncService } from '../platform/sync/types';

/**
 * Déclenchement des cycles (ADR 0011, section 10.1 ; Y-02 critère 1) : à l'ouverture, toutes les 5 minutes tant que la fenêtre est
 * visible, au masquage de la fenêtre (fermeture vers la zone de notification sur PC), avant « Quitter » (5 s au plus). Jamais en
 * arrière-plan. Le minuteur sonde : l'échéance est décidée par l'horloge injectée (4 min 59 s : pas de cycle ; 5 min : un cycle).
 */

/** Période de sondage du minuteur (l'échéance de 5 min est décidée par l'horloge). */
export const SYNC_POLL_MS = 15_000;

export interface SyncSchedulerEnv {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  readonly clock: Clock;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface SyncScheduler {
  /** Sonde une fois (tests). */
  tick(): Promise<void>;
  /** « Quitter » : un dernier cycle, attendu 5 s au plus ; ne rejette jamais. */
  beforeQuit(budgetMs?: number): Promise<void>;
  dispose(): void;
}

export function startSyncScheduler(service: Pick<SyncService, 'syncNow'>, env: SyncSchedulerEnv): SyncScheduler {
  const setTimer = env.setInterval ?? ((handler, ms) => setInterval(handler, ms));
  const clearTimer = env.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let disposed = false;
  let lastStart = env.clock.nowMs();
  const visible = (): boolean => env.document.visibilityState !== 'hidden';

  const run = (reason: SyncReason): Promise<void> => {
    if (disposed) return Promise.resolve();
    lastStart = env.clock.nowMs();
    return service.syncNow(reason).catch(() => undefined);
  };

  const tick = async (): Promise<void> => {
    if (disposed || !visible()) return;
    if (env.clock.nowMs() - lastStart >= SYNC_INTERVAL_MS) await run('timer');
  };

  const onVisibility = (): void => {
    // Masquage de la fenêtre (PC : fermeture vers la zone de notification) : un cycle, puis rien en arrière-plan.
    if (!visible()) void run('hide');
    else void tick();
  };

  env.document.addEventListener('visibilitychange', onVisibility);
  const timer = setTimer(() => void tick(), SYNC_POLL_MS);
  void run('open');

  return {
    tick,
    beforeQuit: async (budgetMs = QUIT_SYNC_BUDGET_MS) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([run('quit'), new Promise<void>((resolve) => (timeout = setTimeout(resolve, budgetMs)))]);
      if (timeout !== undefined) clearTimeout(timeout);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimer(timer);
      env.document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
