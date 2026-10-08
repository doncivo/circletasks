/**
 * Port biométrique (I-03, ADR 0013 §2.2) : Face ID ou Touch ID avec repli sur le code de l'iPhone. Implémentation réelle sur l'iPhone
 * installé (`tauriBiometric.ts`, seul fichier qui nomme le plugin), vide ailleurs, faux pour les tests. Aucune méthode ne rejette.
 */

export type BiometryKind = 'face-id' | 'touch-id' | 'none';

export type AuthFailureCode =
  | 'user-cancel'
  | 'system-cancel'
  | 'app-cancel'
  | 'not-interactive'
  | 'authentication-failed'
  | 'passcode-not-set'
  | 'lockout'
  | 'not-available'
  | 'not-enrolled'
  | 'invalid-context'
  | 'user-fallback'
  /** Plugin absent ou refusé par la capability. */
  | 'unavailable'
  /** Code nul ou inconnu (constat 5 de l'ADR 0013). */
  | 'unknown';

export const AUTH_FAILURE_CODES: readonly AuthFailureCode[] = [
  'user-cancel',
  'system-cancel',
  'app-cancel',
  'not-interactive',
  'authentication-failed',
  'passcode-not-set',
  'lockout',
  'not-available',
  'not-enrolled',
  'invalid-context',
  'user-fallback',
  'unavailable',
  'unknown',
];

export interface BiometricStatus {
  /** Type de biométrie de l'appareil, même indisponible. */
  readonly kind: BiometryKind;
  readonly biometryAvailable: boolean;
  /** `set` si la biométrie est disponible ; `not-set` si `passcodeNotSet` ; sinon `unknown`. */
  readonly passcode: 'set' | 'not-set' | 'unknown';
  readonly code: AuthFailureCode | null;
}

export type AuthResult = { readonly ok: true } | { readonly ok: false; readonly code: AuthFailureCode; readonly cancelled: boolean };

export interface AppAuthenticator {
  /** Faux sur PC et dans le navigateur. */
  readonly supported: boolean;
  /** Valeur figée au lancement du processus (constat 4) : sert au libellé et à l'invitation, jamais à une décision de sécurité. */
  status(): Promise<BiometricStatus>;
  /**
   * Toujours avec repli sur le code de l'iPhone. Raison et « Annuler » non vides, sinon `invalid-context` sans appel. Un seul appel à la
   * fois : un second rend la même promesse.
   */
  authenticate(reason: string, cancelLabel: string): Promise<AuthResult>;
}

const CANCELLED: ReadonlySet<AuthFailureCode> = new Set(['user-cancel', 'system-cancel', 'app-cancel']);

/** Résultat d'échec ; `cancelled` vrai pour les trois annulations. */
export function authFailure(code: AuthFailureCode): AuthResult {
  return { ok: false, code, cancelled: CANCELLED.has(code) };
}

export const UNAVAILABLE_STATUS: BiometricStatus = { kind: 'none', biometryAvailable: false, passcode: 'unknown', code: 'unavailable' };
