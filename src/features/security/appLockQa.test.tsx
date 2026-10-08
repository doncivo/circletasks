import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldLock } from '../../domain/appLock';
import { AUTH_FAILURE_CODES, createFakeAuthenticator, guardAuthenticator, type AuthFailureCode, type FakeAuthenticator } from '../../platform/biometric';
import { createFakePrivacyShield, type FakePrivacyShield } from '../../platform/privacyShield';
import { AppLockGate } from './AppLockGate';
import { resetAppLockStore, useAppLockStore } from './appLockStore';
import { configureExcursions, withExcursion } from './excursion';
import { startAppLock, type AppLockController } from './startAppLock';

/**
 * QA I-03 (lot M, partie 1) : cas limites non couverts par les tests des modules. Un test par critère, nommé avec l'ID.
 * Critères 1, 2, 5, 6, 7, 8, 9, 10 (exécution du verrou, faux plugin, horloge et visibilité injectées).
 */

let visibility: DocumentVisibilityState = 'visible';
let clock = 5_000_000;
let fake: FakeAuthenticator;
let shield: FakePrivacyShield;
let stored: unknown;
let log: ReturnType<typeof vi.fn<(code: string) => void>>;
let controller: AppLockController | null = null;

const state = () => useAppLockStore.getState();
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
};

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function start(options: { readonly read?: () => Promise<unknown> } = {}): Promise<AppLockController> {
  controller = startAppLock({
    authenticator: guardAuthenticator(fake),
    shield,
    readSetting: options.read ?? (() => Promise.resolve(stored)),
    writeSetting: (value) => {
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

async function unlockedApp(): Promise<AppLockController> {
  const lock = await start();
  await lock.unlock();
  expect(state().phase).toBe('unlocked');
  return lock;
}

beforeEach(() => {
  resetAppLockStore();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  clock = 5_000_000;
  fake = createFakeAuthenticator();
  shield = createFakePrivacyShield();
  stored = true;
  log = vi.fn<(code: string) => void>();
  configureExcursions({ now: () => clock, isVisible: () => visibility !== 'hidden' });
  document.body.innerHTML = '<div id="root"><p>contenu</p></div><div id="ct-privacy-cover" aria-hidden="true"></div>';
});

afterEach(() => {
  cleanup();
  controller?.dispose();
  controller = null;
  vi.restoreAllMocks();
  delete document.documentElement.dataset['privacy'];
  delete document.documentElement.dataset['appLock'];
  configureExcursions();
});

describe('I-03-2 réglage security.appLock illisible', () => {
  it.each([['oui'], [1], [0], [{}], [[]], ['false']])('I-03-2 valeur %j : verrouillé, message, journal setting-unreadable', async (value) => {
    stored = value;
    await start();
    expect(state()).toMatchObject({ phase: 'locked', enabled: true, shellReady: false, message: { kind: 'setting-unreadable' } });
    expect(log).toHaveBeenCalledWith('setting-unreadable');
    expect(document.getElementById('root')).toHaveAttribute('hidden');
  });

  it('I-03-2 lecture qui rejette : verrouillé et journalisé, aucune authentification avant la demande', async () => {
    await start({ read: () => Promise.reject(new Error('base')) });
    expect(state().phase).toBe('locked');
    expect(log).toHaveBeenCalledWith('setting-unreadable');
  });

  it('I-03-2 réglage illisible : le bouton déverrouille quand même par authentification (pas de contournement, pas de blocage)', async () => {
    stored = 'oui';
    const lock = await start();
    await lock.unlock();
    expect(state().phase).toBe('unlocked');
    expect(fake.authenticateCount()).toBe(1);
  });

  it('I-03-2 réglage illisible : la sortie « aucun code » n’est pas offerte sans passcode-not-set', async () => {
    stored = 'oui';
    const lock = await start();
    await lock.disableWithoutPasscode();
    expect(state().phase).toBe('locked');
    expect(stored).toBe('oui');
  });
});

describe('I-03-6 échecs de l’authentification : toujours verrouillé, message', () => {
  const REFUSALS: readonly AuthFailureCode[] = ['user-cancel', 'system-cancel', 'app-cancel', 'not-interactive', 'authentication-failed', 'lockout', 'not-available', 'not-enrolled', 'user-fallback', 'invalid-context', 'unavailable', 'unknown'];

  it.each(REFUSALS)('I-03-6 code %s : reste verrouillé, message visible, nouvel essai possible', async (code) => {
    const lock = await start();
    fake.enqueue(code);
    await lock.unlock();
    expect(state()).toMatchObject({ phase: 'locked', shellReady: false, busy: false });
    expect(state().message).not.toBeNull();
    expect(document.getElementById('root')).toHaveAttribute('inert');
    // Aucune limite côté app : l'essai suivant réussit.
    await lock.unlock();
    expect(state().phase).toBe('unlocked');
  });

  it('I-03-6 lockout et biométrie non inscrite : code affiché, jamais de sortie « aucun code »', async () => {
    const lock = await start();
    for (const code of ['lockout', 'not-enrolled', 'not-available'] as const) {
      fake.enqueue(code);
      await lock.unlock();
      expect(state().message).toEqual({ kind: 'failed', code });
      expect(state().noPasscodeExit).toBe(false);
    }
    await lock.disableWithoutPasscode();
    expect(state().phase).toBe('locked');
    expect(stored).toBe(true);
  });

  it('I-03-6 biométrie refusée ou indisponible mais code défini : l’authentification (code seul) déverrouille', async () => {
    fake.setStatus({ kind: 'face-id', biometryAvailable: false, passcode: 'unknown', code: 'not-available' });
    const lock = await start();
    await lock.unlock();
    expect(state().phase).toBe('unlocked');
  });

  it('I-03-6 annulation : message « Déverrouillage annulé », annulation système aussi', async () => {
    const lock = await start();
    fake.enqueue('user-cancel');
    await lock.unlock();
    expect(state().message).toEqual({ kind: 'cancelled' });
    fake.enqueue('app-cancel');
    await lock.unlock();
    expect(state().message).toEqual({ kind: 'cancelled' });
    expect(state().phase).toBe('locked');
  });

  it('I-03-6 les 13 codes connus du port sont couverts par la table de test', () => {
    expect([...REFUSALS, 'passcode-not-set'].sort()).toEqual([...AUTH_FAILURE_CODES].sort());
  });
});

describe('I-03-9 sortie « Désactiver le verrouillage » refusée hors passcode-not-set', () => {
  it.each([['user-cancel'], ['lockout'], ['authentication-failed'], ['not-available'], ['unavailable']] as const)(
    'I-03-9 après %s : refusée, réglage inchangé, aucun déverrouillage',
    async (code) => {
      const lock = await start();
      fake.enqueue(code);
      await lock.unlock();
      await lock.disableWithoutPasscode();
      expect(state()).toMatchObject({ phase: 'locked', noPasscodeExit: false });
      expect(stored).toBe(true);
      expect(log).not.toHaveBeenCalledWith('app-lock-disabled-no-passcode');
    },
  );

  it('I-03-9 déverrouillé : appel direct sans effet (réglage inchangé, aucune journalisation)', async () => {
    const lock = await unlockedApp();
    await lock.disableWithoutPasscode();
    expect(stored).toBe(true);
    expect(state().enabled).toBe(true);
  });

  it('I-03-9 passcode-not-set puis une authentification réussie : plus de sortie offerte', async () => {
    const lock = await start();
    fake.enqueue('passcode-not-set', 'ok');
    await lock.unlock();
    expect(state().noPasscodeExit).toBe(true);
    await lock.unlock();
    expect(state().phase).toBe('unlocked');
    // Nouveau verrou : la sortie ne survit pas à l’épisode précédent.
    setVisibility('hidden');
    clock += 31_000;
    setVisibility('visible');
    await flush();
    expect(state().phase).toBe('unlocked');
  });

  it('I-03-9 sortie confirmée : unique voie sans authentification, journalisée une fois, réglage faux', async () => {
    const lock = await start();
    fake.enqueue('passcode-not-set');
    await lock.unlock();
    await lock.disableWithoutPasscode();
    await lock.disableWithoutPasscode();
    expect(log.mock.calls.filter(([code]) => code === 'app-lock-disabled-no-passcode')).toHaveLength(1);
    expect(stored).toBe(false);
  });
});

describe('I-03-6 double appel d’authentification', () => {
  it('I-03-6 deux unlock() simultanés : une seule fenêtre Face ID', async () => {
    const lock = await start();
    fake.hold();
    const first = lock.unlock();
    const second = lock.unlock();
    await flush();
    expect(fake.authenticateCount()).toBe(1);
    expect(state().busy).toBe(true);
    fake.release();
    await Promise.all([first, second]);
    expect(state().phase).toBe('unlocked');
    expect(fake.authenticateCount()).toBe(1);
  });

  it('I-03-6 requestAutoUnlock puis unlock() pendant l’attente : un seul appel', async () => {
    const lock = await start();
    fake.hold();
    lock.requestAutoUnlock();
    const manual = lock.unlock();
    lock.requestAutoUnlock();
    await flush();
    expect(fake.authenticateCount()).toBe(1);
    fake.release();
    await manual;
    await flush();
    expect(state().phase).toBe('unlocked');
    expect(fake.authenticateCount()).toBe(1);
  });

  it('I-03-6 unlock() après déverrouillage : sans effet', async () => {
    const lock = await unlockedApp();
    await lock.unlock();
    expect(fake.authenticateCount()).toBe(1);
  });

  it('I-03-5 enable() ou disable() simultanés : une seule authentification', async () => {
    stored = false;
    await start();
    fake.hold();
    const actions = state().actions;
    const a = actions?.enable();
    const b = actions?.enable();
    await flush();
    expect(fake.authenticateCount()).toBe(1);
    fake.release();
    await Promise.all([a, b]);
    expect(state().enabled).toBe(true);
    expect(fake.authenticateCount()).toBe(1);
  });

  it('I-03-6 le garde du port : deux appels concurrents partagent la même promesse', async () => {
    const guarded = guardAuthenticator(fake);
    fake.hold();
    const a = guarded.authenticate('Raison', 'Annuler');
    const b = guarded.authenticate('Raison', 'Annuler');
    fake.release();
    expect(await a).toEqual(await b);
    expect(fake.authenticateCount()).toBe(1);
  });
});

describe('I-03-1 retour au premier plan : 29,9 s, 30 s, horloge', () => {
  it('I-03-1 29,9 s : pas de verrou ; 30 s : verrou (via le contrôleur)', async () => {
    await unlockedApp();
    setVisibility('hidden');
    clock += 29_900;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
    setVisibility('hidden');
    clock += 30_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('I-03-1 pagehide puis visible : le délai part du premier passage masqué, pas du dernier', async () => {
    await unlockedApp();
    setVisibility('hidden');
    clock += 20_000;
    window.dispatchEvent(new Event('pagehide'));
    clock += 10_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('I-03-1 deux masquages successifs sans retour : mesure depuis le premier', async () => {
    await unlockedApp();
    setVisibility('hidden');
    clock += 15_000;
    setVisibility('hidden');
    clock += 15_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('I-03-1 horloge qui recule de 1 h : verrouille, même avec une excursion', async () => {
    await unlockedApp();
    void withExcursion('camera', () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock -= 3_600_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('I-03-1 horloge identique (0 ms) : pas de verrou', async () => {
    await unlockedApp();
    setVisibility('hidden');
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
  });

  it('I-03-1 table de la politique pure : bornes 29 999, 30 000, excursion 299 999 et 300 000', () => {
    const base = { enabled: true, state: 'resume', now: 1_000_000 } as const;
    expect(shouldLock({ ...base, backgroundedAt: 1_000_000 - 29_999, excursion: null })).toBe(false);
    expect(shouldLock({ ...base, backgroundedAt: 1_000_000 - 30_000, excursion: null })).toBe(true);
    const out = 1_000_000 - 600_000;
    expect(shouldLock({ ...base, backgroundedAt: 1_000_000 - 40_000, excursion: { startedAt: 1_000_000 - 40_000 - 100 } })).toBe(false);
    expect(shouldLock({ ...base, backgroundedAt: out, excursion: { startedAt: out - 100 } })).toBe(true);
  });
});

describe('I-03-10 excursions', () => {
  it('I-03-10 excursion utilisée deux fois : la seconde sortie en arrière-plan reverrouille', async () => {
    await unlockedApp();
    void withExcursion('system-settings', () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 60_000;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
    setVisibility('hidden');
    clock += 60_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('I-03-10 excursion expirée : arrière-plan de 10 min pendant l’excursion, reverrouillage au retour', async () => {
    await unlockedApp();
    void withExcursion('system-settings', () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 10 * 60_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
    expect(document.getElementById('root')).toHaveAttribute('inert');
  });

  it('I-03-10 excursion de 4 min 59 s : pas de verrou ; juste au-delà de 5 min : verrou', async () => {
    await unlockedApp();
    void withExcursion('system-settings', () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 5 * 60_000 - 1_000;
    setVisibility('visible');
    expect(state().phase).toBe('unlocked');
    void withExcursion('system-settings', () => new Promise<void>(() => undefined));
    setVisibility('hidden');
    clock += 5 * 60_000 + 1;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
  });

  it('I-03-10 excursion déclarée pendant le verrou : sans effet sur le déverrouillage (échec fermé)', async () => {
    const lock = await start();
    void withExcursion('camera', () => new Promise<void>(() => undefined));
    fake.enqueue('user-cancel');
    await lock.unlock();
    expect(state().phase).toBe('locked');
  });

  it('I-03-10 excursion en cours au lancement à froid : ignorée, verrouillé', async () => {
    void withExcursion('camera', () => new Promise<void>(() => undefined));
    await start();
    expect(state().phase).toBe('locked');
  });
});

describe('I-03-8 cache de confidentialité', () => {
  it('I-03-8 cache posé au masquage pendant un verrou déjà posé, retiré au retour sans second verrou', async () => {
    const lock = await start();
    setVisibility('hidden');
    expect(document.documentElement.dataset['privacy']).toBe('on');
    setVisibility('visible');
    expect(document.documentElement.dataset['privacy']).toBeUndefined();
    expect(state().phase).toBe('locked');
    await flush();
    expect(fake.authenticateCount()).toBe(1);
    lock.dispose();
  });

  it('I-03-8 verrou activé en cours de session : le cache est aussitôt actif au masquage suivant', async () => {
    stored = false;
    await start();
    await state().actions?.enable();
    setVisibility('hidden');
    expect(document.documentElement.dataset['privacy']).toBe('on');
  });

  it('I-03-8 verrou désactivé en cours de session : plus de cache', async () => {
    await unlockedApp();
    await state().actions?.disable();
    setVisibility('hidden');
    expect(document.documentElement.dataset['privacy']).toBeUndefined();
  });
});

describe('I-03-7 aucune donnée dans le DOM verrouillé', () => {
  it('I-03-7 lancement à froid verrouillé : tout le contenu de body masqué, seul le verrou lisible', async () => {
    document.body.innerHTML =
      '<div id="root"><ul><li>Acheter du lait</li></ul></div><div id="portal"><p>Sheet</p></div><div id="ct-privacy-cover" aria-hidden="true"></div>';
    await start();
    for (const id of ['root', 'portal']) {
      const node = document.getElementById(id);
      expect(node).toHaveAttribute('hidden');
      expect(node).toHaveAttribute('inert');
      expect(node).toHaveAttribute('aria-hidden', 'true');
    }
    expect(document.getElementById('ct-lock-layer')).not.toHaveAttribute('hidden');
  });

  it('I-03-7 rendu complet : aucune ligne de tâche dans le DOM au lancement à froid verrouillé', async () => {
    resetAppLockStore();
    // Authentification automatique refusée : l'app reste verrouillée quel que soit le moment où l'écran de verrou (à la demande) arrive.
    fake.setDefault('user-cancel');
    const lock = await start();
    render(
      <AppLockGate>
        <ul>
          <li>{'Acheter du lait'}</li>
          <li>{'Appeler le notaire'}</li>
        </ul>
      </AppLockGate>,
    );
    await flush();
    await screen.findByRole('heading', { name: 'CircleTasks est verrouillée' });
    expect(document.body.innerHTML).not.toContain('Acheter du lait');
    expect(document.body.innerHTML).not.toContain('notaire');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    lock.dispose();
  });

  it('I-03-7 au déverrouillage, les attributs d’avant le verrou sont rendus tels quels', async () => {
    document.body.innerHTML = '<div id="root" aria-hidden="false"><p>contenu</p></div><div id="ct-privacy-cover" aria-hidden="true"></div>';
    const lock = await start();
    await lock.unlock();
    const root = document.getElementById('root');
    expect(root).not.toHaveAttribute('hidden');
    expect(root).not.toHaveAttribute('inert');
    expect(root).toHaveAttribute('aria-hidden', 'false');
  });
});

describe('I-03-7 saisie en cours conservée sous le verrou (retour après 30 s)', () => {
  it('I-03-7 contenu monté conservé : champ intact (valeur, focus perdu mais état gardé) au déverrouillage', async () => {
    document.body.innerHTML = '<div id="root"><input id="draft" /></div><div id="ct-privacy-cover" aria-hidden="true"></div>';
    const lock = await unlockedApp();
    const input = document.getElementById('draft') as HTMLInputElement;
    input.value = 'brouillon en cours';
    setVisibility('hidden');
    clock += 45_000;
    setVisibility('visible');
    expect(state().phase).toBe('locked');
    expect(document.getElementById('draft')).toBe(input);
    expect(input.value).toBe('brouillon en cours');
    await flush();
    await lock.unlock();
    expect(state().phase).toBe('unlocked');
    expect(document.getElementById('draft')).toBe(input);
    expect(input.value).toBe('brouillon en cours');
    expect(document.getElementById('root')).not.toHaveAttribute('inert');
  });
});

describe('I-03-9 bandeaux sous verrou', () => {
  it('I-03-9 bandeaux et bandeau « Annuler » dans la coquille : masqués, inertes et hors arbre d’accessibilité sous verrou', async () => {
    resetAppLockStore();
    const lock = await start();
    await lock.unlock();
    render(
      <AppLockGate>
        <div role="status">{'Hors ligne'}</div>
        <button type="button">{'Annuler'}</button>
      </AppLockGate>,
    );
    setVisibility('hidden');
    clock += 31_000;
    fake.enqueue('user-cancel');
    setVisibility('visible');
    await flush();
    const content = screen.getByTestId('app-lock-content');
    expect(content).toHaveAttribute('hidden');
    expect(content).toHaveAttribute('inert');
    expect(content).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Annuler' })).toBeNull();
    expect(content.contains(screen.queryByText('Hors ligne', { ignore: 'x' }))).toBe(true);
  });
});
