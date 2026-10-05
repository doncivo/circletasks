import type { AbsoluteDateParser } from '../../domain/naturalDate';
import { logFailure } from '../../platform';
import { whenIdle } from '../app/idle';

/**
 * Chargement à la demande de l'analyseur des dates écrites (chrono-node, PERF-02, ADR 0001 avenant). Sans React : l'état vit ici, le
 * domaine reçoit l'analyseur en paramètre (`QuickContext.absoluteDates`). Tant qu'il manque, la grammaire locale (demain, jours de
 * semaine, heures) lit déjà la saisie ; les champs se relisent à l'arrivée (`useAbsoluteDateParser`). Un échec est journalisé et le
 * chargement pourra être retenté.
 */
export interface AbsoluteDatesLoader {
  /** Analyseur chargé, ou null. */
  get(): AbsoluteDateParser | null;
  /** Charge (une seule fois en cours) ; se résout toujours, `null` si le chargement échoue. */
  load(): Promise<AbsoluteDateParser | null>;
  subscribe(listener: () => void): () => void;
}

export function createAbsoluteDatesLoader(importer: () => Promise<{ readonly chronoAbsoluteParser: AbsoluteDateParser }>): AbsoluteDatesLoader {
  let parser: AbsoluteDateParser | null = null;
  let pending: Promise<AbsoluteDateParser | null> | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => parser,
    load() {
      if (parser) return Promise.resolve(parser);
      pending ??= importer().then(
        (module) => {
          parser = module.chronoAbsoluteParser;
          for (const listener of listeners) listener();
          return parser;
        },
        (error: unknown) => {
          logFailure('absolute-dates', error);
          pending = null; // nouvel essai possible à la prochaine demande
          return null;
        },
      );
      return pending;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const loader = createAbsoluteDatesLoader(() => import('../../domain/chronoAbsolute'));

export const getAbsoluteDateParser = loader.get;
export const loadAbsoluteDates = loader.load;
export const subscribeAbsoluteDateParser = loader.subscribe;

/** Lance le chargement au premier moment d'inactivité (repli 100 ms sur iPhone). Rend l'annulation. */
export function preloadAbsoluteDates(): () => void {
  return whenIdle(() => void loadAbsoluteDates(), 100, 1500);
}
