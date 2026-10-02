import { todayLocal } from '../../domain/clock';
import { uuidGenerator } from '../../domain/id';
import { msUntilNextLocalMidnight } from '../../domain/taskCarryOver';
import type { LocalDate } from '../../domain/types';
import { createCarryOverUseCases, type CarryOverDeps } from './carryOverUseCases';
import { createRecurrenceUseCases } from './recurrenceUseCases';
import type { TaskUseCaseDeps } from './taskUseCases';

/** `ids` (génération des occurrences récurrentes, T-09) : générateur UUID par défaut. */
export type DayRolloverDeps = CarryOverDeps & Partial<Pick<TaskUseCaseDeps, 'ids'>>;

/** Minuterie injectable (tests : fausse minuterie ; Playwright : horloge simulée du navigateur). */
export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DayRolloverOptions {
  readonly timers?: Timers;
  /** Appelé quand le jour local change (et au premier contrôle), après le report. */
  readonly onDayChange?: (day: LocalDate) => void;
  /** Résultat de chaque report : `true` si échec (affichage d'un message), `false` sinon. */
  readonly onCarryOverResult?: (failed: boolean) => void;
  /** Résultat de la création des occurrences récurrentes (T-09) : message distinct de celui du report. */
  readonly onRecurrenceResult?: (failed: boolean) => void;
}

export interface DayRollover {
  /** Premier contrôle (démarrage de l'app, avant le premier rendu d'Aujourd'hui) puis armement du minuteur. Ne rejette jamais. */
  start(): Promise<void>;
  /** Contrôle immédiat (retour de veille / premier plan) ; ré-arme le minuteur. Ne rejette jamais. */
  check(): Promise<void>;
  stop(): void;
}

/**
 * Plafond du délai d'armement : sous WebView2 un long `setTimeout` peut ne pas compter la
 * veille du PC. Contrôle toutes les 60 s au plus ; `check` est idempotent (un seul report par jour).
 */
export const MAX_ARM_MS = 60_000;

const defaultTimers: Timers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Déclencheurs du report automatique (T-06) : au démarrage, au prochain minuit local
 * pendant que l'app tourne, et au retour au premier plan. Le minuteur est recalculé
 * depuis l'horloge à chaque armement (changement d'heure ou de fuseau sans dérive) ;
 * les contrôles sont sérialisés et idempotents, donc au plus un report effectif par
 * jour local même si plusieurs déclencheurs se chevauchent.
 */
export function createDayRollover(deps: DayRolloverDeps, options: DayRolloverOptions = {}): DayRollover {
  const timers = options.timers ?? defaultTimers;
  const carryOver = createCarryOverUseCases(deps);
  const recurrence = createRecurrenceUseCases({ ...deps, ids: deps.ids ?? uuidGenerator });
  let handle: unknown = null;
  let stopped = false;
  let lastDay: LocalDate | null = null;
  let chain: Promise<void> = Promise.resolve();
  let lastFailed = false;

  const arm = (): void => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
    if (stopped) return;
    handle = timers.setTimeout(() => {
      handle = null;
      void tick();
    }, Math.min(msUntilNextLocalMidnight(deps.clock.nowMs()), MAX_ARM_MS));
  };

  const runOnce = async (): Promise<void> => {
    let failed = false;
    let recurrenceFailed = false;
    try {
      // T-09 (Q2) : l'occurrence suivante est créée à sa date normale AVANT le report, qui change
      // la date des occurrences passées ; un échec n'empêche pas le report.
      await recurrence.generateDue();
    } catch {
      recurrenceFailed = true;
    }
    try {
      await carryOver.run();
    } catch {
      // Échec d'écriture ou de lecture : l'app continue, message dédié, nouvel essai au prochain contrôle.
      failed = true;
    }
    lastFailed = failed || recurrenceFailed;
    options.onCarryOverResult?.(failed);
    options.onRecurrenceResult?.(recurrenceFailed);
    if (stopped) return;
    const day = todayLocal(deps.clock);
    if (day !== lastDay) {
      lastDay = day;
      options.onDayChange?.(day);
    }
  };

  // Minuterie (au plus toutes les 60 s) : on ne relance le report que si le jour
  // local a changé ou si le dernier essai a échoué ; les contrôles explicites
  // (démarrage, focus, retour au premier plan) passent toujours par check().
  const tick = (): Promise<void> => {
    if (!lastFailed && lastDay !== null && todayLocal(deps.clock) === lastDay) {
      chain = chain.then(arm);
      return chain;
    }
    return check();
  };

  const check = (): Promise<void> => {
    chain = chain.then(runOnce).then(arm);
    return chain;
  };

  return {
    start: () => {
      stopped = false;
      return check();
    },
    check,
    stop: () => {
      stopped = true;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}
