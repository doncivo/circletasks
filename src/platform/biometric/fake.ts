import type { RawAuthenticator } from './guard';
import { authFailure, type AuthFailureCode, type AuthResult, type BiometricStatus } from './types';

export type FakeAuthCall = { readonly type: 'status' } | { readonly type: 'authenticate'; readonly reason: string; readonly cancelLabel: string };

/**
 * Faux du plugin biométrique (tests unitaires, e2e en développement via `__ctBiometricFake`) : état réglable, résultats en file
 * (`enqueue`), réussite par défaut. `hold()` garde la prochaine authentification en attente jusqu'à `release()` (appel unique).
 */
export interface FakeAuthenticator extends RawAuthenticator {
  readonly calls: FakeAuthCall[];
  setStatus(status: BiometricStatus): void;
  /** Prochains résultats, dans l'ordre ; une chaîne vaut l'échec de ce code. */
  enqueue(...results: readonly (AuthResult | AuthFailureCode | 'ok')[]): void;
  /** Résultat quand la file est vide (réussite par défaut). */
  setDefault(result: AuthResult | AuthFailureCode | 'ok'): void;
  hold(): void;
  release(): void;
  authenticateCount(): number;
}

const toResult = (value: AuthResult | AuthFailureCode | 'ok'): AuthResult => (value === 'ok' ? { ok: true } : typeof value === 'string' ? authFailure(value) : value);

export const FACE_ID_STATUS: BiometricStatus = { kind: 'face-id', biometryAvailable: true, passcode: 'set', code: null };

export function createFakeAuthenticator(initial: BiometricStatus = FACE_ID_STATUS): FakeAuthenticator {
  let status = initial;
  let fallback: AuthResult = { ok: true };
  const queue: AuthResult[] = [];
  const calls: FakeAuthCall[] = [];
  let held: { promise: Promise<void>; resolve: () => void } | null = null;
  return {
    supported: true,
    calls,
    setStatus: (next) => {
      status = next;
    },
    enqueue: (...results) => {
      queue.push(...results.map(toResult));
    },
    setDefault: (result) => {
      fallback = toResult(result);
    },
    hold: () => {
      let resolve = (): void => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      held = { promise, resolve };
    },
    release: () => {
      const current = held;
      held = null;
      current?.resolve();
    },
    authenticateCount: () => calls.filter((call) => call.type === 'authenticate').length,
    status: () => {
      calls.push({ type: 'status' });
      return Promise.resolve(status);
    },
    authenticate: async (reason, cancelLabel) => {
      calls.push({ type: 'authenticate', reason, cancelLabel });
      if (held) await held.promise;
      return queue.shift() ?? fallback;
    },
  };
}
