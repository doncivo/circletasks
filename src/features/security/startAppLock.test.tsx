import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuthenticator, guardAuthenticator, type BiometricStatus, type FakeAuthenticator } from '../../platform/biometric';
import { createFakePrivacyShield, type FakePrivacyShield } from '../../platform/privacyShield';
import { resetAppLockStore, useAppLockStore } from './appLockStore';
import { configureExcursions, withExcursion } from './excursion';
import { isPrivacyCoverOn } from './privacyCover';
import { startAppLock, type AppLockController } from './startAppLock';

/** I-03 critères 1, 5, 6, 8, 9 et 10 (exécution) : contrôleur du verrou, faux plugin, horloge et visibilité injectées. */

let visibility: DocumentVisibilityState = 'visible';
let clock = 1_000_000;
let fake: FakeAuthenticator;
let shield: FakePrivacyShield;
let stored: unknown;
let writeFails = false;
let log: ReturnType<typeof vi.fn<(code: string) => void>>;
let controller: AppLockController | null = null;

const state = () => useAppLockStore.getState();
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function start(options: { readonly read?: () => Promise<unknown>; readonly supported?: boolean } = {}): Promise<AppLockController> {
  const raw = options.supported === false ? { ...fake, supported: false } : fake;
  controller = startAppLock({
    authenticator: guardAuthenticator(raw),
    shield,
    readSetting: options.read ?? (() => Promise.resolve(stored)),
    writeSetting: (value) => {
      if (writeFails) return Promise.reject(new Error('base occupée'));
      stored = value;
      return Promise.resolve();
    },
    now: () => clock,
    log,
  });
  await controller.ready;
  await flush();
  return controller;
}

beforeEach(() => {
  resetAppLockStore();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  clock = 1_000_000;
  fake = createFakeAuthenticator();
  shield = createFakePrivacyShield();
  stored = false;
  writeFails = false;
  log = vi.fn<(code: string) => void>();
  configureExcursions({ now: () => clock, isVisible: () => visibility !== 'hidden' });
  document.body.innerHTML = '<div id="root"><p>contenu</p></div><div id="ct-privacy-cover" aria-hidden="true"></div>';
});

afterEach(() => {
  controller?.dispose();
  controller = null;
  delete document.documentElement.dataset['privacy'];
  delete document.documentElement.dataset['appLock'];
  configureExcursions();
});

describe('démarrage (critères 1, 2 et 6)', () => {
  it('désactivé : déverrouillé, coquille autorisée, aucune authentification ; cache natif désactivé', async () => {
    await start();
    expect(state()).toMatchObject({ phase: 'unlocked', enabled: false, shellReady: true });
    expect(fake.authenticateCount()).toBe(0);
    expect(shield.calls).toEqual([false]);
  });

  it('activé : verrouillé à froid, coquille non autorisée, contenu de body masqué ; cache natif activé', async () => {
    stored = true;
    await start();
    expect(state()).toMatchObject({ phase: 'locked', enabled: true, shellReady: false, message: null });
    const root = document.getElementById('root');
    expect(root).toHaveAttribute('hidden');
    expect(root).toHaveAttribute('inert');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(document.documentElement.dataset['appLock']).toBe('locked');
    expect(document.getElementById('ct-lock-layer')).not.toBeNull();
    expect(document.getElementById('ct-lock-layer')).not.toHaveAttribute('hidden');
    expect(shield.calls).toEqual([true]);
  });

  it('réglage illisible : verrouillé (échec fermé), message, journal setting-unreadable', async () => {
    stored = 'oui';
    await start();
    expect(state()).toMatchObject({ phase: 'locked', enabled: true, message: { kind: 'setting-unreadable' } });
    expect(log).toHaveBeenCalledWith('setting-unreadable');
  });

  it('lecture du réglage impossible : verrouillé, jamais déverrouillé', async () => {
    await start({ read: () => Promise.reject(new Error('base')) });
    expect(state()).toMatchObject({ phase: 'locked', enabled: true, message: { kind: 'setting-unreadable' } });
  });

  it('PC et navigateur (authentification non prise en charge) : jamais de verrou, même avec un réglage illisible', async () => {
    stored = 'oui';
    await start({ supported: false });
    expect(state()).toMatchObject({ phase: 'unlocked', shellReady: true, enabled: false });
    expect(document.getElementById('root')).not.toHaveAttribute('hidden');
  });
});

describe('déverrouillage (critères 6 et 9)', () => {
  beforeEach(() => {
    stored = true;
  });

  it('authentification automatique une fois par épisode, puis bouton ; réussite : déverrouillé, body rendu', async () => {
    const lock = await start();
    fake.enqueue('user-cancel');
    lock.requestAutoUnlock();
    await flush();
    lock.requestAutoUnlock();
    await flush();
    expect(fake.authenticateCount()).toBe(1);
    expect(fake.calls.at(-1)).toEqual({ type: 'authenticate', reason: 'Déverrouiller CircleTasks', cancelLabel: 'Annuler' });
    expect(state()).toMatchObject({ phase: 'locked', message: { kind: 'cancelled' } });
    await lock.unlock();
    expect(state()).toMatchObject({ phase: 'unlocked', shellReady: true, message: null });
    expect(document.getElementById('root')).not.toHaveAttribute('hidden');
    expect(document.getElementById('root')).not.toHaveAttribute('inert');
    expect(document.getElementById('root')).not.toHaveAttribute('aria-hidden');
  });

  it('document masqué : aucune authentification automatique avant le retour visible', async () => {
    visibility = 'hidden';
    const lock = await start();
    lock.requestAutoUnlock();
    await flush();
    expect(fake.authenticateCount()).toBe(0);
    setVisibility('visible');
    await flush();
    expect(fake.authenticateCount()).toBe(1);
  });

  it('not-interactive : un seul nouvel essai au prochain focus, puis le bouton seulement (pas de boucle)', async () => {
    const lock = await start();
    fake.enqueue('not-interactive', 'system-cancel');
    lock.requestAutoUnlock();
    await flush();
    window.dispatchEvent(new Event('focus'));
    await flush();
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(fake.authenticateCount()).toBe(2);
    expect(state().phase).toBe('locked');
  });

  it('échecs : code affiché ; plugin indisponible ou code inconnu : message persistant, jamais déverrouillé', async () => {
    const lock = await start();
    fake.enqueue('authentication-failed');
    await lock.unlock();
    expect(state().message).toEqual({ kind: 'failed', code: 'authentication-failed' });
    for (const code of ['unavailable', 'unknown', 'invalid-context'] as const) {
      fake.enqueue(code);
      await lock.unlock();
      expect(state()).toMatchObject({ phase: 'locked', message: { kind: 'plugin', code } });
    }
    expect(state().noPasscodeExit).toBe(false);
  });

  it('aucun code sur l’iPhone : reste verrouillé, sortie proposée seulement après passcode-not-set ; confirmée : réglage faux, journal, déverrouillé', async () => {
    const lock = await start();
    // `status` seul ne suffit jamais (figé au lancement, constat 4).
    fake.setStatus({ kind: 'none', biometryAvailable: false, passcode: 'not-set', code: 'passcode-not-set' });
    await lock.disableWithoutPasscode();
    expect(state().phase).toBe('locked');
    fake.enqueue('passcode-not-set');
    await lock.unlock();
    expect(state()).toMatchObject({ phase: 'locked', noPasscodeExit: true, message: { kind: 'no-passcode' } });
    await lock.disableWithoutPasscode();
    expect(stored).toBe(false);
    expect(log).toHaveBeenCalledWith('app-lock-disabled-no-passcode');
    expect(state()).toMatchObject({ phase: 'unlocked', enabled: false, noPasscodeExit: false });
    expect(shield.calls.at(-1)).toBe(false);
  });

  it('sortie « aucun code » : écriture impossible → reste verrouillé avec un message', async () => {
    const lock = await start();
    fake.enqueue('passcode-not-set');
    await lock.unlock();
    writeFails = true;
    await lock.disableWithoutPasscode();
    expect(state()).toMatchObject({ phase: 'locked', message: { kind: 'disable-failed' } });
  });
});

describe('retour au premier plan et cache de confidentialité (critères 6, 8 et 10)', () => {
  beforeEach(() => {
    stored = true;
  });

  async function unlockedApp(): Promise<AppLockController> {
    const lock = await start();
    await lock.unlock();
    expect(state().phase).toBe('unlocked');
    return lock;
  }

  it('cache posé aussitôt au passage masqué, même avant 30 s ; retiré au retour sans authentification sous 30 s', async () => {
    await unlockedApp();
    setVisibility('hidden');
    expect(isPrivacyCoverOn(document)).toBe(true);
    clock += 29_999;
    setVisibility('visible');
    expect(isPrivacyCoverOn(document)).toBe(false);
    expect(state().phase).toBe('unlocked');
    expect(fake.authenticateCount()).toBe(1);
  });

  it('pagehide pose aussi le cache', async () => {
    await unlockedApp();
    window.dispatchEvent(new Event('pagehide'));
    expect(isPrivacyCoverOn(document)).toBe(true);
  });

  it('retour après 30 s : verrou posé AVANT le retrait du cache, coquille conservée, authentification automatique', async () => {
    await unlockedApp();
    setVisibility('hidden');
    clock += 30_000;
    const order: string[] = [];
    const unsubscribe = useAppLockStore.subscribe((next) => order.push(`${next.phase}:${isPrivacyCoverOn(document) ? 'cache' : 'sans'}`));
    setVisibility('visible');
    unsubscribe();
    expect(order[0]).toBe('locked:cache');
    expect(isPrivacyCoverOn(document)).toBe(false);
    expect(state()).toMatchObject({ phase: 'locked', shellReady: true });
    expect(document.getElementById('root')).toHaveAttribute('inert');
    await flush();
    expect(fake.authenticateCount()).toBe(2);
  });

  it('excursion vers Réglages iOS : pas de reverrouillage au retour, même après 30 s ; consommée une fois', async () => {
    await unlockedApp();
    void withExcursion('system-settings', () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 60_000;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
    setVisibility('hidden');
    clock += 30_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it.each(['camera', 'folder-picker', 'permission'] as const)('audit M1 : excursion %s et VRAI passage en arrière-plan : règle des 30 s', async (kind) => {
    await unlockedApp();
    void withExcursion(kind, () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 29_999;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
    void withExcursion(kind, () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 30_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('excursion de plus de 5 min : reverrouillage', async () => {
    await unlockedApp();
    void withExcursion('system-settings', () => Promise.resolve());
    await flush();
    setVisibility('hidden');
    clock += 5 * 60_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('excursion terminée sans passage en arrière-plan (sélecteur dans l’app) : effacée, les 30 s s’appliquent ensuite', async () => {
    await unlockedApp();
    await withExcursion('folder-picker', () => Promise.resolve('dossier'));
    setVisibility('hidden');
    clock += 30_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('Réglages iOS : l’excursion survit à la résolution immédiate de la promesse', async () => {
    await unlockedApp();
    await withExcursion('system-settings', () => Promise.resolve());
    setVisibility('hidden');
    clock += 120_000;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
  });

  it('horloge qui recule : verrouille', async () => {
    await unlockedApp();
    setVisibility('hidden');
    clock -= 1;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('verrou désactivé : aucun cache, aucun verrou', async () => {
    stored = false;
    await start();
    setVisibility('hidden');
    expect(isPrivacyCoverOn(document)).toBe(false);
    clock += 3_600_000;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
  });

  it('dispose : écouteurs retirés', async () => {
    const lock = await unlockedApp();
    lock.dispose();
    controller = null;
    setVisibility('hidden');
    expect(isPrivacyCoverOn(document)).toBe(false);
  });
});

describe('activer et désactiver (critères 5 et 9)', () => {
  it('activer : authentification d’abord (raison « Activer le verrouillage de CircleTasks ») ; réussite : activé, cache natif', async () => {
    await start();
    await state().actions?.enable();
    expect(fake.calls.at(-1)).toEqual({ type: 'authenticate', reason: 'Activer le verrouillage de CircleTasks', cancelLabel: 'Annuler' });
    expect(state()).toMatchObject({ enabled: true, phase: 'unlocked', settingsMessage: null });
    expect(stored).toBe(true);
    expect(shield.calls).toEqual([false, true]);
  });

  it('activer : annulation ou échec → réglage inchangé, « Le verrouillage n’a pas été activé »', async () => {
    await start();
    fake.enqueue('user-cancel');
    await state().actions?.enable();
    expect(stored).toBe(false);
    expect(state()).toMatchObject({ enabled: false, settingsMessage: { main: 'notEnabled', detail: null } });
    fake.enqueue('unavailable');
    await state().actions?.enable();
    expect(state().settingsMessage).toEqual({ main: 'notEnabled', detail: 'unsupported', code: 'unavailable' });
  });

  it('aucun code défini : activation refusée SANS appel ; passcode-not-set rendu par l’appel : même raison', async () => {
    await start();
    fake.setStatus({ kind: 'face-id', biometryAvailable: false, passcode: 'not-set', code: 'passcode-not-set' } satisfies BiometricStatus);
    await state().actions?.enable();
    expect(fake.authenticateCount()).toBe(0);
    expect(state().settingsMessage).toEqual({ main: 'notEnabled', detail: 'noPasscode', code: null });
    fake.setStatus({ kind: 'none', biometryAvailable: false, passcode: 'unknown', code: 'not-available' });
    fake.enqueue('passcode-not-set');
    await state().actions?.enable();
    expect(state()).toMatchObject({ enabled: false, settingsMessage: { detail: 'noPasscode' } });
  });

  it('biométrie indisponible mais code défini : l’appel tranche (code seul) et active', async () => {
    await start();
    fake.setStatus({ kind: 'face-id', biometryAvailable: false, passcode: 'unknown', code: 'not-available' });
    await state().actions?.enable();
    expect(state().enabled).toBe(true);
  });

  it('écriture impossible : non activé, message', async () => {
    await start();
    writeFails = true;
    await state().actions?.enable();
    expect(state()).toMatchObject({ enabled: false, settingsMessage: { main: 'notEnabled', detail: 'saveFailed' } });
  });

  it('désactiver exige aussi une authentification ; échec : reste activé', async () => {
    stored = true;
    const lock = await start();
    await lock.unlock();
    fake.enqueue('authentication-failed');
    await state().actions?.disable();
    expect(state()).toMatchObject({ enabled: true, settingsMessage: { main: 'notDisabled' } });
    await state().actions?.disable();
    expect(fake.calls.at(-1)).toMatchObject({ reason: 'Désactiver le verrouillage de CircleTasks' });
    expect(state()).toMatchObject({ enabled: false, settingsMessage: null });
    expect(stored).toBe(false);
    expect(shield.calls.at(-1)).toBe(false);
  });

  it('échec du cache natif : code gardé pour Réglages, journalisé', async () => {
    shield.failWith('unavailable');
    stored = true;
    await start();
    expect(state().shieldFailure).toBe('unavailable');
    expect(log).toHaveBeenCalledWith('privacy-shield-failed:unavailable');
  });
});
