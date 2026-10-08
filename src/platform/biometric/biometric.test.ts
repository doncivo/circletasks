import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuthenticator, createUnavailableAuthenticator, guardAuthenticator, openAuthenticator, UNAVAILABLE_STATUS } from './index';
import { createTauriAuthenticator, failureCodeOf, parseStatus } from './tauriBiometric';

describe('adaptateur Tauri du plugin biometric (ADR 0013 §2.2, constats 3 à 6)', () => {
  it('authenticate : toujours avec repli sur le code de l’iPhone, raison et « Annuler » transmis', async () => {
    const call = vi.fn(() => Promise.resolve(undefined));
    const raw = createTauriAuthenticator(call);
    await expect(raw.authenticate('Déverrouiller CircleTasks', 'Annuler')).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('plugin:biometric|authenticate', { reason: 'Déverrouiller CircleTasks', allowDeviceCredential: true, cancelTitle: 'Annuler' });
  });

  it('rejets du Swift : table des codes, annulations marquées, code nul ou inconnu → unknown', async () => {
    const cases = [
      ['userCancel', 'user-cancel', true],
      ['systemCancel', 'system-cancel', true],
      ['appCancel', 'app-cancel', true],
      ['notInteractive', 'not-interactive', false],
      ['authenticationFailed', 'authentication-failed', false],
      ['passcodeNotSet', 'passcode-not-set', false],
      ['biometryLockout', 'lockout', false],
      ['biometryNotAvailable', 'not-available', false],
      ['biometryNotEnrolled', 'not-enrolled', false],
      ['invalidContext', 'invalid-context', false],
      ['userFallback', 'user-fallback', false],
      ['', 'unknown', false],
      ['toString', 'unknown', false],
    ] as const;
    for (const [code, mapped, cancelled] of cases) {
      const raw = createTauriAuthenticator(() => Promise.reject({ message: 'texte système', code }));
      await expect(raw.authenticate('r', 'a')).resolves.toEqual({ ok: false, code: mapped, cancelled });
    }
    // Rejet sans code (LAError absent de la table : code nul côté Swift).
    await expect(createTauriAuthenticator(() => Promise.reject({ message: 'x' })).authenticate('r', 'a')).resolves.toMatchObject({ code: 'unknown' });
  });

  it('plugin absent ou refusé par la capability : unavailable', () => {
    expect(failureCodeOf('Command plugin:biometric|authenticate not allowed by ACL')).toBe('unavailable');
    expect(failureCodeOf(new Error('plugin biometric not found'))).toBe('unavailable');
    expect(failureCodeOf(new Error('autre chose'))).toBe('unknown');
    expect(failureCodeOf(42)).toBe('unknown');
  });

  it('status : Face ID, Touch ID, aucun ; code « passcodeNotSet » → aucun code défini', () => {
    expect(parseStatus({ isAvailable: true, biometryType: 2 })).toEqual({ kind: 'face-id', biometryAvailable: true, passcode: 'set', code: null });
    expect(parseStatus({ isAvailable: true, biometryType: 1 })).toEqual({ kind: 'touch-id', biometryAvailable: true, passcode: 'set', code: null });
    expect(parseStatus({ isAvailable: false, biometryType: 2, error: 'x', errorCode: 'biometryNotAvailable' })).toEqual({ kind: 'face-id', biometryAvailable: false, passcode: 'unknown', code: 'not-available' });
    expect(parseStatus({ isAvailable: false, biometryType: 0, errorCode: 'passcodeNotSet' })).toEqual({ kind: 'none', biometryAvailable: false, passcode: 'not-set', code: 'passcode-not-set' });
    expect(parseStatus({ isAvailable: false, biometryType: 4, errorCode: '' })).toEqual({ kind: 'none', biometryAvailable: false, passcode: 'unknown', code: 'unknown' });
    expect(parseStatus(null)).toMatchObject({ biometryAvailable: false, code: 'unknown' });
  });

  it('status en échec : indisponible avec le code, jamais un rejet', async () => {
    const raw = createTauriAuthenticator(() => Promise.reject(new Error('not allowed by ACL')));
    await expect(raw.status()).resolves.toEqual({ kind: 'none', biometryAvailable: false, passcode: 'unknown', code: 'unavailable' });
  });
});

describe('règles communes du port (guardAuthenticator)', () => {
  it('raison ou « Annuler » vide : invalid-context sans appel (une raison vide arrête l’app, constat 5)', async () => {
    const fake = createFakeAuthenticator();
    const guarded = guardAuthenticator(fake);
    await expect(guarded.authenticate('', 'Annuler')).resolves.toEqual({ ok: false, code: 'invalid-context', cancelled: false });
    await expect(guarded.authenticate('Déverrouiller', '  ')).resolves.toMatchObject({ code: 'invalid-context' });
    expect(fake.authenticateCount()).toBe(0);
  });

  it('un seul appel à la fois : le second rend la même promesse', async () => {
    const fake = createFakeAuthenticator();
    fake.hold();
    const guarded = guardAuthenticator(fake);
    const first = guarded.authenticate('r', 'a');
    const second = guarded.authenticate('r', 'a');
    expect(second).toBe(first);
    fake.release();
    await expect(first).resolves.toEqual({ ok: true });
    expect(fake.authenticateCount()).toBe(1);
    // Après la fin : un nouvel appel part.
    await guarded.authenticate('r', 'a');
    expect(fake.authenticateCount()).toBe(2);
  });

  it('ne rejette jamais ; journal : code seulement', async () => {
    const log = vi.fn();
    const guarded = guardAuthenticator(
      {
        supported: true,
        status: () => Promise.reject(new Error('boum')),
        authenticate: () => Promise.reject(new Error('secret')),
      },
      log,
    );
    await expect(guarded.authenticate('r', 'a')).resolves.toEqual({ ok: false, code: 'unknown', cancelled: false });
    await expect(guarded.status()).resolves.toEqual(UNAVAILABLE_STATUS);
    expect(log.mock.calls.flat()).toEqual(['biometric-auth:unknown', 'biometric-status-failed']);
  });
});

describe('résolveur (I-03 critère 3)', () => {
  afterEach(() => {
    delete (globalThis as { __ctBiometric?: unknown }).__ctBiometric;
    delete (globalThis as { __ctBiometricFake?: unknown }).__ctBiometricFake;
  });

  it('PC et navigateur : non pris en charge, toute authentification rend unavailable', async () => {
    for (const [runtime, os] of [['tauri', 'windows'], ['web', 'ios'], ['web', 'other']] as const) {
      const authenticator = openAuthenticator(runtime, os, { log: () => undefined });
      expect(authenticator.supported).toBe(false);
      await expect(authenticator.authenticate('r', 'a')).resolves.toEqual({ ok: false, code: 'unavailable', cancelled: false });
      await expect(authenticator.status()).resolves.toEqual(UNAVAILABLE_STATUS);
    }
    expect(createUnavailableAuthenticator().supported).toBe(false);
  });

  it('développement : __ctBiometricFake expose le faux en __ctBiometric', async () => {
    (globalThis as { __ctBiometricFake?: boolean }).__ctBiometricFake = true;
    const authenticator = openAuthenticator('web', 'other', { log: () => undefined });
    expect(authenticator.supported).toBe(true);
    const fake = (globalThis as { __ctBiometric?: ReturnType<typeof createFakeAuthenticator> }).__ctBiometric;
    fake?.enqueue('user-cancel');
    await expect(authenticator.authenticate('r', 'a')).resolves.toEqual({ ok: false, code: 'user-cancel', cancelled: true });
  });

  it('iPhone installé : chargement de l’adaptateur impossible → unavailable, jamais un déverrouillage', async () => {
    vi.doMock('./tauriBiometric', () => {
      throw new Error('chargement impossible');
    });
    try {
      // L'adaptateur est importé à la demande, au premier appel : le module simulé est celui chargé.
      const authenticator = openAuthenticator('tauri', 'ios', { log: () => undefined });
      expect(authenticator.supported).toBe(true);
      await expect(authenticator.authenticate('r', 'a')).resolves.toMatchObject({ ok: false, code: 'unavailable' });
    } finally {
      vi.doUnmock('./tauriBiometric');
    }
  });
});
