import { detectOs, detectRuntime } from '../../platform';
import { currentLogJournal, installLogJournal, logFailure } from '../../platform/desktop/log';

/** Code du dernier échec d'installation du journal (bloc à la demande illisible), ou null. */
let installError: string | null = null;

/**
 * Installe le journal technique de la fenêtre au démarrage (I-04, ADR 0014 §3), chargé à la demande pour garder le bundle de départ :
 * les entrées notées avant attendent dans `log.ts`. `main` : fichier (app installée) ou mémoire (développement) ; `focus` : session seule.
 * Un échec de chargement est noté (`journalInstallError`) et peut être retenté depuis l'écran Logs (« Réessayer »).
 */
let starting: Promise<void> | null = null;

export function startLogJournal(windowLabel: 'main' | 'focus'): Promise<void> {
  // Jamais deux journaux : déjà installé -> rien ; chargement en cours -> le même (revue, mineur : « Réessayer » répété).
  if (currentLogJournal()) return Promise.resolve();
  starting ??= import('../../platform/logs').then(
    ({ openLogJournal }) => {
      installError = null;
      if (!currentLogJournal()) installLogJournal(openLogJournal(detectRuntime(), detectOs(), windowLabel));
    },
    (error: unknown) => {
      installError = 'load-failed';
      starting = null;
      logFailure('logs', error);
    },
  );
  return starting;
}

export function journalInstallError(): string | null {
  return installError;
}
