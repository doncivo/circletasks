import type { SyncRepository } from '../../db/repositories';
import { logFailure } from '../../platform/desktop/log';
import type { SyncEngineService } from '../../platform/sync/types';
import type { Timers } from '../tasks/dayRollover';

/**
 * T-TECH-01 (B8, décisions D1 à D3) : porte de synchro du premier report. Sur chaque appareil, le premier contrôle (génération des
 * occurrences, report des tâches en retard) part sur une base qui n'a pas encore lu l'autre : une tâche terminée ou déplacée ailleurs
 * serait reportée sur des données périmées. La porte retient ce premier contrôle jusqu'au premier cycle de synchro conclu (réussi ou en
 * échec), ou 12 s, ou ne le retient pas du tout quand aucune synchro n'est configurée. Elle ne retient JAMAIS le premier rendu
 * (`startup.ts` ne l'attend pas) et ne repasse pas pour les contrôles suivants (retour au premier plan, minuit).
 *
 * Module chargé à la demande (bundle de départ, PRD 8). Signal : l'état existant du service de synchro (`status()`, `subscribe()`), sans
 * toucher au moteur. Un échec du cycle reste visible par les états A-09 (`syncTrouble`, `waitingIcloud`) posés par `startSync.ts` ; la porte
 * s'ouvre alors (`failed`) sans attendre les 12 s.
 */
export const FIRST_CYCLE_GATE_MS = 12_000;

/** `done` : cycle réussi ; `failed` : cycle conclu en échec ; `not-configured` : rien à attendre ; `timeout` : 12 s sans conclusion. */
export type GateOutcome = 'done' | 'failed' | 'not-configured' | 'timeout';

export interface FirstCycleGate {
  /** Vrai : le premier contrôle attend `outcome` ; faux : il part tout de suite (aucune minuterie armée). */
  readonly waits: boolean;
  readonly outcome: Promise<GateOutcome>;
  /** Arrête la minuterie et l'écoute (démontage de l'app). */
  cancel(): void;
}

const NO_GATE: FirstCycleGate = { waits: false, outcome: Promise.resolve('not-configured'), cancel: () => undefined };

const defaultTimers: Timers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Une seule porte par démarrage : la minuterie de 12 s est armée ici, une fois. */
export async function startFirstCycleGate(sync: SyncEngineService, repo: Pick<SyncRepository, 'getStates'>, timers: Timers = defaultTimers): Promise<FirstCycleGate> {
  // « Synchro configurée » = au moins un appareil connu dans l'état local (`sync_state`, écrit par le premier cycle) : une lecture de la base,
  // jamais un appel natif (le verrou du service Rust et iCloud Drive pourraient suspendre le premier rendu, I1).
  let configured = true;
  try {
    configured = (await repo.getStates()).length > 0;
  } catch (error) {
    // État illisible : on attend le cycle (qui rend l'échec visible), au plus 12 s ; jamais de report sur un état inconnu sans trace.
    logFailure('sync', error);
  }
  if (!configured) return NO_GATE;
  const initial = sync.status();
  let open: (outcome: GateOutcome) => void = () => undefined;
  const outcome = new Promise<GateOutcome>((resolve) => {
    open = resolve;
  });
  let stop: () => void = () => undefined;
  const timer = timers.setTimeout(() => close('timeout'), FIRST_CYCLE_GATE_MS);
  stop = sync.subscribe(() => {
    const status = sync.status();
    // Conclu : plus de cycle en cours, et l'état a changé depuis le démarrage (heure de dernière synchro, ou phase d'échec).
    if (status.phase === 'syncing' || status.progress !== null) return;
    if (status.lastSyncAt === initial.lastSyncAt && status.phase === initial.phase) return;
    // Réussi seulement si le cycle est complet (phase idle) et a daté la synchro ; fichiers iCloud en attente (waiting-icloud) ou échec : failed.
    close(status.phase === 'idle' && status.lastSyncAt !== initial.lastSyncAt ? 'done' : 'failed');
  });
  function close(result: GateOutcome): void {
    stop();
    timers.clearTimeout(timer);
    open(result);
  }
  return { waits: true, outcome, cancel: () => close('timeout') };
}
