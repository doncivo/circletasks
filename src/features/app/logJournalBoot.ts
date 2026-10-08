import { detectOs, detectRuntime } from '../../platform';
import { installLogJournal, logFailure } from '../../platform/desktop/log';

/**
 * Installe le journal technique de la fenêtre au démarrage (I-04, ADR 0014 §3), chargé à la demande pour garder le bundle de départ :
 * les entrées notées avant attendent dans `log.ts`. `main` : fichier (app installée) ou mémoire (développement) ; `focus` : session seule.
 */
export function startLogJournal(windowLabel: 'main' | 'focus'): Promise<void> {
  return import('../../platform/logs').then(
    ({ openLogJournal }) => installLogJournal(openLogJournal(detectRuntime(), detectOs(), windowLabel)),
    (error: unknown) => logFailure('logs', error),
  );
}
