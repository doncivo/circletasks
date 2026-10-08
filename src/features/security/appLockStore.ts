import { create } from 'zustand';

/**
 * État du verrouillage de l'app (I-03, ADR 0013 §2.4), global au processus : il existe avant le conteneur (lu au démarrage avec
 * l'apparence) et survit aux écrans. Échec fermé : `unknown` → `locked` | `unlocked` ; seul un `authenticate` réussi (ou la sortie
 * « aucun code » confirmée) passe de `locked` à `unlocked`.
 */
export type LockPhase = 'unknown' | 'locked' | 'unlocked';

export type LockMessage =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'no-passcode' }
  | { readonly kind: 'plugin'; readonly code: string }
  | { readonly kind: 'setting-unreadable' }
  | { readonly kind: 'disable-failed' };

export interface SettingsLockMessage {
  readonly main: 'notEnabled' | 'notDisabled';
  readonly detail: 'noPasscode' | 'unsupported' | 'saveFailed' | null;
  readonly code: string | null;
}

/** Actions exposées à l'interface (posées par `startAppLock`). */
export interface AppLockActions {
  unlock(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  disableWithoutPasscode(): Promise<void>;
  /** Écran de verrou affiché : authentification automatique, une fois par épisode, si le document est visible. */
  requestAutoUnlock(): void;
}

export interface AppLockState {
  readonly phase: LockPhase;
  /** Réglage `security.appLock` (lu ; illisible = vrai). */
  readonly enabled: boolean;
  /** Vrai dès que la coquille peut être montée dans ce processus (premier déverrouillage, ou verrou inactif au lancement). */
  readonly shellReady: boolean;
  readonly busy: boolean;
  readonly message: LockMessage | null;
  /** Sortie « Désactiver le verrouillage » : seulement après un `authenticate` de ce processus rendant `passcode-not-set`. */
  readonly noPasscodeExit: boolean;
  /** Message de Réglages > Sécurité (activation ou désactivation refusée). */
  readonly settingsMessage: SettingsLockMessage | null;
  /** Code d'échec du cache natif ; affiché dans Réglages > Sécurité. */
  readonly shieldFailure: string | null;
  readonly actions: AppLockActions | null;
}

export const INITIAL_APP_LOCK_STATE: AppLockState = {
  phase: 'unknown',
  enabled: false,
  shellReady: false,
  busy: false,
  message: null,
  noPasscodeExit: false,
  settingsMessage: null,
  shieldFailure: null,
  actions: null,
};

export const useAppLockStore = create<AppLockState>()(() => INITIAL_APP_LOCK_STATE);

/** Tests : état initial. */
export function resetAppLockStore(): void {
  useAppLockStore.setState(INITIAL_APP_LOCK_STATE, true);
}

/** Vrai si l'interface est verrouillée (raccourcis inactifs, coquille masquée). */
export function isAppLocked(): boolean {
  return useAppLockStore.getState().phase !== 'unlocked';
}
