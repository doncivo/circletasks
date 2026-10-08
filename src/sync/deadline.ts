import type { Clock } from '../domain/clock';
import { HYDRATE_CYCLE_TIMEOUT_MS } from '../domain/sync/limits';

/**
 * Échéance d'un cycle (ADR 0011 §22 point 6 ; Y-IOS-01 critères 9 à 11) : seul le cycle lancé au passage de l'iPhone en arrière-plan
 * (`syncNow('hide', { deadlineAt })`) en a une. Le moteur compare l'horloge injectée à l'échéance **avant** chaque unité atomique, jamais
 * pendant : le scan ; chaque page lue avec sa transaction d'application ; chaque ajout au journal avec l'inscription `inflight` qui le précède
 * et le retrait de la file qui le suit ; l'écriture de l'état ; chaque page d'instantané ; chaque suppression de fichiers ; l'heure de
 * dernière synchro. Atteinte, elle lève `CycleInterrupted` : le cycle s'arrête là (issue `interrupted`), rien n'est perdu ni marqué complet.
 */

/** Unités atomiques du cycle, avant lesquelles l'échéance est comparée. */
export type DeadlineUnit = 'scan' | 'read-page' | 'snapshot-read' | 'append' | 'write-state' | 'snapshot-page' | 'delete-own' | 'forgotten-delete' | 'finish';

/** Marge laissée à la fin d'une hydratation avant l'échéance (`hydrateBudgetMs` du scan = échéance − maintenant − 2 s). */
export const HYDRATE_DEADLINE_MARGIN_MS = 2_000;

/** Arrêt d'un cycle à son échéance : jamais une erreur affichée, jamais un échec enregistré. */
export class CycleInterrupted extends Error {
  override readonly name = 'CycleInterrupted';
  readonly unit: DeadlineUnit;

  constructor(unit: DeadlineUnit) {
    super('cycle interrompu');
    this.unit = unit;
  }
}

export function isCycleInterrupted(error: unknown): error is CycleInterrupted {
  return error instanceof CycleInterrupted;
}

export interface CycleDeadline {
  /** Avant une unité atomique : lève `CycleInterrupted` si l'échéance est atteinte (et, une fois atteinte, à chaque appel suivant). */
  check(unit: DeadlineUnit): void;
  /** Budget d'hydratation du scan : échéance − maintenant − 2 s, au moins 1 ms, au plus 3 minutes. */
  hydrateBudgetMs(): number;
  /** L'échéance a-t-elle interrompu le cycle ? */
  readonly fired: boolean;
}

/** `probe` (tests) : appelé avant chaque comparaison, avec l'unité ; un test y avance l'horloge pour arrêter le cycle à une frontière donnée. */
export function createCycleDeadline(clock: Clock, deadlineAt: number, probe?: (unit: DeadlineUnit) => void): CycleDeadline {
  let fired = false;
  return {
    check(unit) {
      probe?.(unit);
      if (fired || clock.nowMs() >= deadlineAt) {
        fired = true;
        throw new CycleInterrupted(unit);
      }
    },
    hydrateBudgetMs: () => Math.min(HYDRATE_CYCLE_TIMEOUT_MS, Math.max(1, Math.floor(deadlineAt - clock.nowMs() - HYDRATE_DEADLINE_MARGIN_MS))),
    get fired() {
      return fired;
    },
  };
}

/** Pages d'instantané à écrire, l'échéance comparée avant chaque page (un instantané interrompu reste un `.tmp`, ignoré et recréé). */
export async function* pagesBefore(deadline: CycleDeadline | undefined, pages: AsyncIterable<readonly string[]>): AsyncIterable<readonly string[]> {
  for await (const page of pages) {
    deadline?.check('snapshot-page');
    yield page;
  }
}
