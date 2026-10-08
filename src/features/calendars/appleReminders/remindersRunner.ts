import type { AppContainer } from '../../app/container';
import { EMPTY_REPORT, runRemindersPass, type PassKind, type PassReport } from './remindersPass';
import { createSender } from './remindersWrites';

/**
 * Coordinateur des passages (K-05 critère 11, ADR 0008 §10.8) sur le modèle de `NotificationRunner` (ADR 0012 N1.3) : au plus UN passage
 * en cours et UN passage en attente ; une rafale de 20 déclencheurs donne au plus deux passages. Deux sortes : `full` (ouverture, reprise,
 * `changed`, synchro reçue, arrière-plan, geste manuel) et `push` (écriture locale d'une tâche liée ou à créer), lancé après un délai
 * (`PUSH_DELAY_MS`) qui laisse passer l'annulation de 5 s (T-13) : une annulation avant le passage ne produit aucune écriture. Un `full`
 * en attente absorbe un `push`. Les déclencheurs d'un même passage reçoivent le même résultat.
 */
export type RemindersTrigger = 'open' | 'resume' | 'changed' | 'sync' | 'hide' | 'manual' | 'edit';

/** Délai entre une écriture locale et le passage `push` : 5 s d'annulation (T-13) plus une seconde. */
export const PUSH_DELAY_MS = 6_000;

export interface RemindersRunner {
  /** Demande un passage ; se résout à la fin du passage qui la sert. Ne rejette jamais. */
  request(trigger: RemindersTrigger): Promise<PassReport>;
  /** Annule le passage `push` programmé (démontage) ; le coordinateur reste utilisable (remontage). */
  dispose(): void;
}

interface Waiting {
  readonly promise: Promise<PassReport>;
  readonly resolve: (report: PassReport) => void;
  kind: PassKind;
  deadlineAt?: number;
}

export interface RunnerTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: RunnerTimers = { setTimeout: (handler, ms) => setTimeout(handler, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/** Passage borné au masquage (iPhone) : au-delà de cette durée il n'entame plus de paquet (rien n'est perdu, la reprise est à l'ouverture suivante). */
export const HIDE_PASS_BUDGET_MS = 8_000;

export function createRemindersRunner(pass: (kind: PassKind, deadlineAt?: number) => Promise<PassReport>, timers: RunnerTimers = systemTimers, nowMs: () => number = () => Date.now()): RemindersRunner {
  let running = false;
  let waiting: Waiting | null = null;
  let pushTimer: unknown = null;
  let pushPending: Promise<PassReport> | null = null;
  let pushResolve: ((report: PassReport) => void) | null = null;

  const execute = async (kind: PassKind, deadlineAt?: number): Promise<PassReport> => {
    running = true;
    let report: PassReport;
    try {
      report = await pass(kind, deadlineAt);
    } catch {
      // `pass` ne rejette pas (il enregistre ses échecs) ; garde-fou : le passage suivant repart.
      report = { ...EMPTY_REPORT, status: 'failed', code: 'pass-failed' };
    }
    const next = waiting;
    waiting = null;
    if (next === null) {
      running = false;
    } else {
      // Le passage en attente démarre aussitôt (running reste vrai) ; sa promesse est celle de tous les déclencheurs coalescés.
      void execute(next.kind, next.deadlineAt).then(next.resolve);
    }
    return report;
  };

  const schedule = (kind: PassKind, deadlineAt?: number): Promise<PassReport> => {
    if (!running) return execute(kind, deadlineAt);
    if (waiting === null) {
      let resolve!: (report: PassReport) => void;
      const promise = new Promise<PassReport>((r) => {
        resolve = r;
      });
      waiting = { promise, resolve, kind, ...(deadlineAt === undefined ? {} : { deadlineAt }) };
    } else if (kind === 'full') {
      waiting.kind = 'full';
      if (deadlineAt !== undefined) waiting.deadlineAt = deadlineAt;
    }
    return waiting.promise;
  };

  return {
    request: (trigger) => {
      if (trigger === 'edit') {
        // Écriture locale : un seul passage `push` programmé, quelle que soit la rafale.
        if (pushPending === null) {
          pushPending = new Promise<PassReport>((resolve) => {
            pushResolve = resolve;
          });
          pushTimer = timers.setTimeout(() => {
            const resolve = pushResolve;
            pushTimer = null;
            pushPending = null;
            pushResolve = null;
            void schedule('push').then((report) => resolve?.(report));
          }, PUSH_DELAY_MS);
        }
        return pushPending;
      }
      return schedule('full', trigger === 'hide' ? nowMs() + HIDE_PASS_BUDGET_MS : undefined);
    },
    dispose: () => {
      if (pushTimer !== null) timers.clearTimeout(pushTimer);
      pushTimer = null;
      pushResolve?.({ ...EMPTY_REPORT, status: 'skipped' });
      pushResolve = null;
      pushPending = null;
    },
  };
}

const runners = new WeakMap<AppContainer, RemindersRunner>();

/** Le coordinateur de ce conteneur : tous les déclencheurs passent par lui. */
export function getRemindersRunner(container: AppContainer): RemindersRunner {
  let known = runners.get(container);
  if (known === undefined) {
    const send = createSender(container);
    known = createRemindersRunner((kind, deadlineAt) => runRemindersPass(container, kind, { send, ...(deadlineAt === undefined ? {} : { deadlineAt }) }), systemTimers, () => container.clock.nowMs());
    runners.set(container, known);
  }
  return known;
}
