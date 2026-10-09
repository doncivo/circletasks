import type { AppContainer } from '../app/container';
import { replanNotifications, type ReplanOutcome, type ReplanTrigger } from './replanNotifications';

/**
 * Sérialisation et coalescence des passages (N-01 critère 8, ADR 0012 avenant N1.3) : au plus UN passage en cours et UN passage en
 * attente, jamais deux `replace` simultanés. Un déclencheur arrivé pendant un passage marque le passage en attente (relance unique à
 * la fin) et sa promesse se résout à la fin de CE passage suivant. Aucune minuterie de regroupement.
 */
export interface NotificationRunner {
  request(trigger: ReplanTrigger): Promise<ReplanOutcome>;
  /**
   * P-04-iOS (mise au calme avant une restauration) : plus aucun passage ne démarre (les demandes attendent) ; résout quand le passage en
   * cours, actions N-03 comprises, est fini.
   */
  pause(): Promise<void>;
  /** Reprise : les demandes en attente partent en un passage. */
  resume(): void;
}

interface Waiting {
  readonly promise: Promise<ReplanOutcome>;
  readonly resolve: (outcome: ReplanOutcome) => void;
  readonly triggers: ReplanTrigger[];
}

export function createNotificationRunner(pass: (trigger: ReplanTrigger) => Promise<ReplanOutcome>): NotificationRunner {
  let running = false;
  let paused = false;
  let current: Promise<ReplanOutcome> | null = null;
  let waiting: Waiting | null = null;

  const execute = async (trigger: ReplanTrigger): Promise<ReplanOutcome> => {
    running = true;
    let outcome: ReplanOutcome;
    try {
      outcome = await pass(trigger);
    } catch {
      // `pass` ne rejette pas (il enregistre ses échecs) ; garde-fou : le passage suivant repart.
      outcome = { status: 'failed', reason: 'schedule-failed' };
    }
    const next = paused ? null : waiting;
    if (!paused) waiting = null;
    if (next === null) {
      running = false;
      current = null;
    } else {
      // Le passage en attente démarre aussitôt (running reste vrai) ; sa promesse est celle de tous les déclencheurs coalescés.
      current = execute(next.triggers[0] ?? 'edit');
      void current.then(next.resolve);
    }
    return outcome;
  };

  const start = (trigger: ReplanTrigger): Promise<ReplanOutcome> => {
    current = execute(trigger);
    return current;
  };

  return {
    pause: async () => {
      paused = true;
      while (running && current) await current.catch(() => undefined);
    },
    resume: () => {
      paused = false;
      const next = waiting;
      if (running || next === null) return;
      waiting = null;
      void start(next.triggers[0] ?? 'edit').then(next.resolve);
    },
    request: (trigger) => {
      if (!running && !paused) return start(trigger);
      if (waiting === null) {
        let resolve!: (outcome: ReplanOutcome) => void;
        const promise = new Promise<ReplanOutcome>((r) => {
          resolve = r;
        });
        waiting = { promise, resolve, triggers: [] };
      }
      waiting.triggers.push(trigger);
      return waiting.promise;
    },
  };
}

const runners = new WeakMap<AppContainer, NotificationRunner>();

/** Le coordinateur de ce conteneur : tous les déclencheurs (ouverture, reprise, synchro, édition, fuseau, autorisation) passent par lui. */
export function getNotificationRunner(container: AppContainer): NotificationRunner {
  let known = runners.get(container);
  if (known === undefined) {
    known = createNotificationRunner((trigger) => replanNotifications(container, trigger));
    runners.set(container, known);
  }
  return known;
}
