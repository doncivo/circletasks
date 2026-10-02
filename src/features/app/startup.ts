import { createDayRollover } from '../tasks/dayRollover';
import { createTrashUseCases } from '../tasks/trashUseCases';
import { useAppStore } from './appStore';
import type { AppContainer } from './container';

export interface AppStartup {
  /** Premier contrôle de report terminé (avant le premier rendu d'Aujourd'hui). Ne rejette jamais. */
  readonly ready: Promise<void>;
  /** Arrête minuterie et écouteurs ; sûr avant la fin de `ready` (aucun réarmement ensuite) et idempotent. */
  dispose(): void;
}

/** Cibles d'événements injectables (tests). */
export interface StartupEnv {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Orchestration de démarrage (T-06) : premier contrôle du report, minuterie de minuit
 * (bornée à 60 s côté rollover, robuste à la veille du PC) et contrôles au retour au
 * premier plan (`visibilitychange`) et à la prise de focus de la fenêtre (`focus`).
 * T-08 : purge de la corbeille (tâches supprimées depuis plus de 30 jours) lancée au démarrage,
 * sans bloquer `ready` ; un échec est sans conséquence (nouvelle tentative au prochain démarrage).
 */
export function startAppStartup(
  container: AppContainer,
  env: StartupEnv = { document, window },
): AppStartup {
  const rollover = createDayRollover(container, {
    onDayChange: (day) => useAppStore.getState().setDay(day),
    onCarryOverResult: (failed) => useAppStore.getState().setCarryOverFailed(failed),
    onRecurrenceResult: (failed) => useAppStore.getState().setRecurrenceFailed(failed),
  });
  const onCheck = (): void => {
    if (env.document.visibilityState !== 'hidden') void rollover.check();
  };
  env.document.addEventListener('visibilitychange', onCheck);
  env.window.addEventListener('focus', onCheck);
  const ready = rollover.start();
  void ready.then(() => createTrashUseCases(container).purgeExpired()).catch(() => undefined);
  let disposed = false;
  return {
    ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      env.document.removeEventListener('visibilitychange', onCheck);
      env.window.removeEventListener('focus', onCheck);
      rollover.stop();
    },
  };
}
