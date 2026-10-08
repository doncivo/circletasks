import { invoke } from '@tauri-apps/api/core';
import type { RawAuthenticator } from './guard';
import { authFailure, type AuthFailureCode, type AuthResult, type BiometricStatus, type BiometryKind } from './types';

/**
 * Adaptateur iOS du plugin officiel `tauri-plugin-biometric` =2.4.1 (ADR 0013 §2.1, constats 3 à 6) : SEUL fichier qui nomme
 * `plugin:biometric|` (test de cohérence). Aucune commande Rust : les appels vont directement au Swift.
 * - `status` → `{ isAvailable, biometryType, error?, errorCode? }` (`biometryType` : `LABiometryType.rawValue`, 1 Touch ID, 2 Face ID) ;
 * - `authenticate` → `{ reason, allowDeviceCredential, cancelTitle }` ; rejet `{ message, code }` (code de la table du Swift, nul si inconnu).
 * Rien d'autre que le code n'est journalisé ni rendu.
 */

export type PluginInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const PLUGIN = 'plugin:biometric|';

/** Plugin absent ou commande refusée par la capability (message de Tauri, jamais affiché). */
const UNAVAILABLE_MESSAGE = /window is not defined|__TAURI|reading 'invoke'|not allowed|plugin .*not found|command .*not found|not registered|unknown command|no such plugin/i;

const SWIFT_CODES: Readonly<Record<string, AuthFailureCode>> = {
  userCancel: 'user-cancel',
  systemCancel: 'system-cancel',
  appCancel: 'app-cancel',
  notInteractive: 'not-interactive',
  authenticationFailed: 'authentication-failed',
  passcodeNotSet: 'passcode-not-set',
  biometryLockout: 'lockout',
  biometryNotAvailable: 'not-available',
  biometryNotEnrolled: 'not-enrolled',
  invalidContext: 'invalid-context',
  userFallback: 'user-fallback',
};

/** Code d'un rejet du plugin (objet `{ code }` du Swift, ou message de Tauri). */
export function failureCodeOf(error: unknown): AuthFailureCode {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && Object.hasOwn(SWIFT_CODES, code)) return SWIFT_CODES[code] ?? 'unknown';
    return 'unknown';
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return UNAVAILABLE_MESSAGE.test(message) ? 'unavailable' : 'unknown';
}

function kindOf(value: unknown): BiometryKind {
  return value === 2 ? 'face-id' : value === 1 ? 'touch-id' : 'none';
}

/** Lecture de la réponse de `status` (forme inattendue : indisponible, code `unknown`). */
export function parseStatus(value: unknown): BiometricStatus {
  if (typeof value !== 'object' || value === null) return { kind: 'none', biometryAvailable: false, passcode: 'unknown', code: 'unknown' };
  const raw = value as { isAvailable?: unknown; biometryType?: unknown; errorCode?: unknown };
  const kind = kindOf(raw.biometryType);
  if (raw.isAvailable === true) return { kind, biometryAvailable: true, passcode: 'set', code: null };
  const code = typeof raw.errorCode === 'string' && Object.hasOwn(SWIFT_CODES, raw.errorCode) ? (SWIFT_CODES[raw.errorCode] ?? 'unknown') : 'unknown';
  return { kind, biometryAvailable: false, passcode: code === 'passcode-not-set' ? 'not-set' : 'unknown', code };
}

export function createTauriAuthenticator(call: PluginInvoke = (command, args) => invoke(command, args)): RawAuthenticator {
  return {
    supported: true,
    status: async () => {
      try {
        return parseStatus(await call(`${PLUGIN}status`));
      } catch (error) {
        return { kind: 'none', biometryAvailable: false, passcode: 'unknown', code: failureCodeOf(error) };
      }
    },
    authenticate: async (reason, cancelLabel): Promise<AuthResult> => {
      try {
        await call(`${PLUGIN}authenticate`, { reason, allowDeviceCredential: true, cancelTitle: cancelLabel });
        return { ok: true };
      } catch (error) {
        return authFailure(failureCodeOf(error));
      }
    },
  };
}
