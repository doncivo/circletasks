import { authFailure, UNAVAILABLE_STATUS, type AppAuthenticator, type AuthResult, type BiometricStatus } from './types';

/** Implémentation brute : peut rejeter ; `guardAuthenticator` la rend sûre. */
export interface RawAuthenticator {
  readonly supported: boolean;
  status(): Promise<BiometricStatus>;
  authenticate(reason: string, cancelLabel: string): Promise<AuthResult>;
}

/**
 * Règles communes du port (ADR 0013 §2.2), appliquées à toute implémentation (réelle et faux) : raison ou « Annuler » vide →
 * `invalid-context` sans appel (une raison vide arrête l'app côté iOS, constat 5) ; un seul appel à la fois (un second rend la même
 * promesse) ; jamais de rejet (rejet inattendu → `unknown`, journalisé par code seulement).
 */
export function guardAuthenticator(raw: RawAuthenticator, log: (code: string) => void = () => undefined): AppAuthenticator {
  let running: Promise<AuthResult> | null = null;
  return {
    supported: raw.supported,
    status: () =>
      Promise.resolve()
        .then(() => raw.status())
        .catch(() => {
          log('biometric-status-failed');
          return UNAVAILABLE_STATUS;
        }),
    authenticate: (reason, cancelLabel) => {
      if (reason.trim() === '' || cancelLabel.trim() === '') return Promise.resolve(authFailure('invalid-context'));
      if (running) return running;
      const call = Promise.resolve()
        .then(() => raw.authenticate(reason, cancelLabel))
        .catch(() => authFailure('unknown'))
        .then((result) => {
          if (!result.ok) log(`biometric-auth:${result.code}`);
          return result;
        })
        .finally(() => {
          running = null;
        });
      running = call;
      return call;
    },
  };
}
