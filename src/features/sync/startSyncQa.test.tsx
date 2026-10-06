// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { SYNC_ERROR_CODES } from '../../domain/sync/format';
import { SYNC_PHASES, SYNC_TROUBLE_ORDER } from '../../domain/syncBanners';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { en } from '../../i18n/en';
import { fr } from '../../i18n/fr';
import { DEFAULT_LOCALE, registerCatalog, setLocale } from '../../i18n';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { useAppStatusStore } from '../app/appStatus';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { JOIN_STATE_META } from './pairingStatus';
import { startSyncIntegration, type SyncIntegration } from './startSync';
import { statusLine } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * QA de A-09 (critère 9) : exigence d'Ali « aucun échec silencieux ». Pour chaque phase et chaque état bloqué : un bandeau existe, il
 * survit à un redémarrage tant que l'état n'est pas résolu, il disparaît à la résolution. Aucun délai réel : `SyncService` factice, base
 * SQLite de test, horloge manuelle, minuterie factice déclenchée à la main. Les tests nommés « DÉFAUT QA » décrivent le comportement
 * attendu d'un défaut constaté : `it.fails` les garde verts tant que le défaut existe et les fait échouer dès qu'il est corrigé
 * (il faut alors remplacer `it.fails` par `it`).
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const LAPTOP = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000c3');
const NOW = '2026-10-06T08:00:00.000Z';
const JOIN = { epoch: 'e0001-x', from: SELF, seq: 1, done: 8, total: 20, failure: 'io' };

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;
let integration: SyncIntegration | null;
let timers: { handler: () => void; ms: number; cleared: boolean }[];

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;

function start(): SyncIntegration {
  integration = startSyncIntegration(container, {
    document: fakeDocument,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: (handler, ms) => {
      const timer = { handler, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  return integration;
}

/** Redémarrage simulé : l'app s'arrête (les états posés sont retirés) puis repart sur la même base et le même service. */
function restart(): SyncIntegration {
  integration?.dispose();
  integration = null;
  let next: SyncIntegration | null = null;
  act(() => {
    next = start();
  });
  return next as unknown as SyncIntegration;
}

function fireTimers(): void {
  for (const timer of timers.splice(0)) if (!timer.cleared) act(() => timer.handler());
}

const banner = (): HTMLElement | null => screen.queryByRole('status');
const set = (patch: Partial<SyncStatus>): void => act(() => sync.setStatus(patch));
const device = (deviceId: DeviceId, platform: 'ios' | 'windows', status: SyncDeviceStatus['status'], self = false): SyncDeviceStatus => ({ deviceId, platform, self, status, lastReadAt: null });
const sources = () => useAppStatusStore.getState().sources;
const text = (): string | null => banner()?.textContent ?? null;
const settle = async (): Promise<void> => {
  await act(async () => {
    await integration?.refreshed();
  });
};

/** États posés dans le store à chaque changement (suite des états actifs, null = aucun). */
function recordBanners(): { seen: (string | null)[]; stop: () => void } {
  const keys = (): string | null => Object.keys(useAppStatusStore.getState().sources).sort().join('+') || null;
  const seen: (string | null)[] = [keys()];
  const stop = useAppStatusStore.subscribe(() => seen.push(keys()));
  return { seen, stop };
}

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService();
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
  timers = [];
  integration = null;
  useNavigationStore.setState(INITIAL_NAVIGATION);
});

afterEach(async () => {
  cleanup();
  integration?.dispose();
  integration = null;
  setLocale(DEFAULT_LOCALE);
  vi.restoreAllMocks();
  await db.close();
});

/** Chaque phase et son état bloqué, avec de quoi la poser. */
const BLOCKED: readonly { name: string; patch: Partial<SyncStatus> }[] = [
  { name: 'error', patch: { phase: 'error', errorCode: 'folder-unreachable' } },
  { name: 'key-mismatch', patch: { phase: 'key-mismatch' } },
  { name: 'clock-ahead', patch: { phase: 'clock-ahead', clockAheadDevice: PHONE, devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'clock-ahead')] } },
  { name: 'needs-pairing', patch: { phase: 'needs-pairing' } },
  { name: 'restore-choice', patch: { phase: 'restore-choice' } },
  { name: 'waiting-icloud', patch: { phase: 'waiting-icloud', errorCode: 'cloud-provider-stopped' } },
  // Y-10 : appareil local oublié.
  { name: 'forgotten', patch: { phase: 'forgotten' } },
  // Y-11 : appareil à associer de nouveau après une réinitialisation.
  { name: 'reset-required', patch: { phase: 'reset-required' } },
];

describe('aucun échec silencieux : chaque phase bloquée (9 c, 9 e, 9 i)', () => {
  it('toutes les phases de SYNC_PHASES sont dans ce tableau ou ont une raison explicite de ne rien afficher', () => {
    const quiet = ['idle', 'syncing', 'not-configured', 'update-required'];
    expect([...BLOCKED.map((b) => b.patch.phase), ...quiet].sort()).toEqual([...SYNC_PHASES].sort());
  });

  for (const { name, patch } of BLOCKED) {
    it(`${name} : bandeau tout de suite, présent après changement de page, redémarrage et passage du temps, retiré à la résolution`, async () => {
      render(<AppStatusBanner />);
      await start().refreshed();
      set(patch);
      expect(banner(), name).not.toBeNull();
      expect(banner()?.textContent).toContain(statusLine(sync.status(), db.clock.nowMs()));
      const shown = text();

      // Ni la navigation ni le temps ne le retirent.
      act(() => useNavigationStore.getState().navigate({ tab: 'settings', screen: 'sync' }));
      db.clock.advance(40 * 86_400_000);
      await settle();
      expect(text(), 'navigation et temps').toBe(shown);

      // Redémarrage (le service garde la même phase) : revient dès le démarrage, avant la première relecture de la base.
      const next = restart();
      expect(banner(), 'dès le démarrage').not.toBeNull();
      await act(async () => {
        await next.refreshed();
      });
      expect(banner()?.textContent).toContain(statusLine(sync.status(), db.clock.nowMs()));

      // Résolution : disparaît.
      set({ phase: 'idle', errorCode: null, clockAheadDevice: null, devices: [], lastSyncAt: NOW as IsoDateTime });
      await settle();
      expect(banner(), 'résolu').toBeNull();
      expect(sources()).toEqual({});
    });
  }

  it('chaque phase en échec ou bloquée (sauf l’attente) a un bouton « Voir » nommé', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    for (const phase of ['needs-pairing', 'restore-choice', 'key-mismatch', 'error', 'clock-ahead', 'forgotten'] as const) {
      set({ phase });
      expect(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }), phase).toBeTruthy();
    }
  });

  it('chaque code d’erreur, en échec comme en attente : texte de Réglages, sans chemin ni clé, role="status" (9 h)', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    for (const phase of ['error', 'waiting-icloud'] as const) {
      for (const errorCode of SYNC_ERROR_CODES) {
        set({ phase, errorCode });
        const line = statusLine(sync.status(), db.clock.nowMs());
        expect(line, `${phase}/${errorCode}`).not.toBe('');
        expect(banner()?.textContent, `${phase}/${errorCode}`).toContain(line);
        expect(line).not.toMatch(/[\\/]|[A-Za-z]:|\.ctx|\.jsonl|CT1-|CTPAIR/);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getAllByRole('status')).toHaveLength(1);
      }
    }
  });
});

describe('aucun échec silencieux : états persistés et appareils (9 f, 9 i)', () => {
  for (const status of ['foreign', 'corrupt', 'rollback'] as const) {
    it(`appareil ${status} : bandeau avant le premier cycle, après redémarrage, retiré quand l’appareil est de nouveau actif`, async () => {
      await db.data.repos.sync.saveState(SELF, { isSelf: true, platform: 'windows', status: 'active' });
      await db.data.repos.sync.saveState(PHONE, { platform: 'ios', status, stateSeq: 3 });
      await db.data.repos.sync.saveState(LAPTOP, { platform: 'windows', status: 'active', stateSeq: 2 });
      render(<AppStatusBanner />);
      await act(async () => {
        await start().refreshed();
      });
      const shown = text();
      expect(shown, status).not.toBeNull();
      expect(shown).toContain('iPhone');
      await act(async () => {
        await restart().refreshed();
      });
      expect(text()).toBe(shown);

      // Un cycle conclut avec l'appareil toujours en l'état : le bandeau reste ; avec l'appareil actif : il part.
      set({ phase: 'idle', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', status), device(LAPTOP, 'windows', 'active')] });
      await settle();
      expect(text()).toBe(shown);
      set({ phase: 'idle', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'active'), device(LAPTOP, 'windows', 'active')] });
      await settle();
      expect(banner()).toBeNull();
    });
  }

  it('arrivée en échec : retirée par la seule réussite (meta effacée), pas par un cycle ni le temps ; revient après redémarrage', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, JSON.stringify(JOIN));
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    expect(sources().syncTrouble?.detail).toBe('join-failed');
    for (const phase of ['syncing', 'idle', 'waiting-icloud', 'idle'] as const) {
      set({ phase, lastSyncAt: NOW as IsoDateTime });
      await settle();
      expect(sources().syncTrouble?.detail, phase).toBe('join-failed');
    }
    await act(async () => {
      await restart().refreshed();
    });
    expect(sources().syncTrouble?.detail).toBe('join-failed');
    await db.data.repos.sync.setMeta(JOIN_STATE_META, null);
    set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, conflictsThisWeek: 2 });
    await settle();
    expect(sources().syncTrouble).toBeUndefined();
  });

  it('échec de réintégration : bandeau même sans synchro configurée, présent après redémarrage, retiré à la résolution', async () => {
    const failure = { fields: 2, tables: ['task'], at: NOW as IsoDateTime, errors: ['x'] };
    sync.setStatus({ phase: 'not-configured', reintegrationFailure: failure });
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    expect(sources().updateRequired?.detail).toBe('reintegration');
    expect(text()).toContain('n’ont pas pu être intégrés');
    restart();
    expect(sources().updateRequired?.detail).toBe('reintegration');
    set({ reintegrationFailure: null });
    expect(sources().updateRequired).toBeUndefined();
  });

  it('une valeur illisible de sync_meta.join est ignorée sans lever', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, '{pas du json');
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    expect(banner()).toBeNull();
  });

  it('une relecture lente ne ressuscite pas un état résolu entre-temps (la dernière relecture fait foi)', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    vi.spyOn(db.data.repos.sync, 'getMeta').mockImplementation(async () => {
      calls += 1;
      if (calls > 1) return null;
      await slow;
      return JSON.stringify(JOIN);
    });
    render(<AppStatusBanner />);
    const first = start();
    set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime });
    release();
    await act(async () => {
      await first.refreshed();
    });
    expect(sources().syncTrouble).toBeUndefined();
  });

  it('une lecture qui aboutit après dispose() ne repose rien, un état émis ensuite non plus', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, JSON.stringify(JOIN));
    const real = db.data.repos.sync.getMeta.bind(db.data.repos.sync);
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(db.data.repos.sync, 'getMeta').mockImplementation(async (key) => {
      const value = await real(key);
      await slow;
      return value;
    });
    const running = start();
    running.dispose();
    release();
    await running.refreshed();
    expect(sources()).toEqual({});
    set({ phase: 'error', errorCode: 'io' });
    expect(sources()).toEqual({});
  });

  // Défaut constaté : `readPersisted` (startSync.ts) avale l'erreur de lecture (« base occupée : état précédent gardé »). Au démarrage
  // l'état précédent est « rien » : une arrivée en échec ou un appareil illisible reste invisible, et la lecture elle-même n'est
  // signalée nulle part. Corrigé (revue A-09, point 1) : état `state-unreadable`.
  it('DÉFAUT QA-1 (corrigé) : une lecture de sync_meta ou de sync_state en échec au démarrage est signalée (aucun échec silencieux)', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, JSON.stringify(JOIN));
    vi.spyOn(db.data.repos.sync, 'getMeta').mockRejectedValue(new Error('base occupée'));
    vi.spyOn(db.data.repos.sync, 'getStates').mockRejectedValue(new Error('base occupée'));
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    expect(banner()).not.toBeNull();
  });
});

describe('priorités et « (+N) » (9 a, 9 g)', () => {
  it('N compte exactement les autres états, diminue à chaque résolution, et le plus urgent passe devant', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, JSON.stringify(JOIN));
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    set({ phase: 'error', errorCode: 'io', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'corrupt'), device(LAPTOP, 'windows', 'rollback')] });
    await settle();
    // échec > arrivée en échec > corrupt > rollback : 3 autres états.
    expect(sources().syncTrouble?.detail).toBe('error');
    expect(sources().syncTrouble?.more).toBe(3);
    expect(text()).toMatch(/\(\+3\)/);
    set({ devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'corrupt'), device(LAPTOP, 'windows', 'active')] });
    expect(text()).toMatch(/\(\+2\)/);
    await db.data.repos.sync.setMeta(JOIN_STATE_META, null);
    set({ conflictsThisWeek: 1 });
    await settle();
    expect(text()).toMatch(/\(\+1\)/);
    set({ devices: [device(SELF, 'windows', 'active', true)] });
    expect(sources().syncTrouble?.more).toBe(0);
    expect(text()).not.toMatch(/\(\+/);
  });

  it('l’ordre écrit n’a pas de doublon ; clé avant échec avant horloge ; arrivée en échec avant les appareils', () => {
    const order = SYNC_TROUBLE_ORDER as readonly string[];
    expect(new Set(order).size).toBe(order.length);
    expect(order.indexOf('key-mismatch')).toBeLessThan(order.indexOf('error'));
    expect(order.indexOf('error')).toBeLessThan(order.indexOf('clock-ahead'));
    expect(order.indexOf('join-failed')).toBeLessThan(order.indexOf('device-foreign'));
  });

  it('clé différente + arrivée en échec : la clé d’abord (+1) ; un appareil étranger en plus ne s’ajoute pas (même état)', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, JSON.stringify(JOIN));
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    set({ phase: 'key-mismatch', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'foreign')] });
    await settle();
    expect(sources().syncTrouble?.detail).toBe('key-mismatch');
    expect(sources().syncTrouble?.more).toBe(1);
  });

  it('« Hors ligne » ne masque aucun état d’échec, avant comme après, et réapparaît une fois l’échec résolu', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    for (const { name, patch } of BLOCKED.filter((b) => b.name !== 'waiting-icloud')) {
      act(() => useAppStatusStore.getState().setStatus('offline', {}));
      set(patch);
      expect(text(), `${name} avec Hors ligne`).not.toBe('Hors ligne');
      expect(sources().syncTrouble).toBeDefined();
      set({ phase: 'idle', errorCode: null, devices: [], clockAheadDevice: null });
      expect(text(), `${name} résolu`).toBe('Hors ligne');
      act(() => useAppStatusStore.getState().setStatus('offline', null));
    }
  });

  it('un échec passe devant « En attente d’iCloud » et « Synchro en cours » posés par ailleurs', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    act(() => {
      useAppStatusStore.getState().setStatus('waitingIcloud', {});
      useAppStatusStore.getState().setStatus('syncing', {});
    });
    set({ phase: 'key-mismatch' });
    expect(text()).toContain('autre clé');
  });
});

describe('« Synchro en cours » jamais avant 1 s ; pas de clignotement entre deux cycles (9 d)', () => {
  it('aucun bandeau tant que la minuterie de 1 s n’est pas échue, quel que soit le nombre de mises à jour pendant le cycle', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    set({ phase: 'syncing' });
    for (let done = 1; done <= 5; done += 1) set({ phase: 'syncing', progress: { done, total: 5 } });
    expect(banner()).toBeNull();
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
    expect(timers[0]?.ms).toBe(1_000);
    fireTimers();
    expect(text()).toBe('Synchro en cours');
  });

  it('une minuterie échue après la fin du cycle n’affiche rien (cycle fini pile au seuil)', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    set({ phase: 'syncing' });
    const armed = timers[0];
    set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime });
    act(() => armed?.handler());
    expect(banner()).toBeNull();
    expect(sources().syncing).toBeUndefined();
  });

  it('chaque cycle réarme son propre seuil de 1 s (le bandeau d’un cycle long ne fuit pas sur le suivant court)', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    set({ phase: 'syncing' });
    fireTimers();
    expect(text()).toBe('Synchro en cours');
    set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime });
    expect(banner()).toBeNull();
    set({ phase: 'syncing' });
    expect(banner()).toBeNull();
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1);
  });

  it('toutes les 5 minutes : dix cycles courts de suite ne posent jamais aucun état dans le store', async () => {
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    const { seen, stop } = recordBanners();
    for (let i = 0; i < 10; i += 1) {
      set({ phase: 'syncing' });
      set({ phase: 'idle', lastSyncAt: NOW as IsoDateTime });
      db.clock.advance(300_000);
    }
    await settle();
    stop();
    expect(seen.filter((entry) => entry !== null)).toEqual([]);
  });

  for (const { name, patch } of BLOCKED.filter((b) => b.name !== 'waiting-icloud')) {
    it(`échec « ${name} » qui dure : entre deux cycles de 5 minutes, le bandeau ne s’éteint ni ne change`, async () => {
      render(<AppStatusBanner />);
      await act(async () => {
        await start().refreshed();
      });
      set(patch);
      await settle();
      const { seen, stop } = recordBanners();
      for (let i = 0; i < 3; i += 1) {
        set({ phase: 'syncing' });
        fireTimers();
        set(patch);
        await settle();
      }
      stop();
      // « Synchro en cours » (moins prioritaire) peut être posé pendant le cycle, jamais sans l'échec.
      for (const entry of seen) expect(entry, `${name} : ${JSON.stringify(seen)}`).toMatch(/syncTrouble|updateRequired/);
    });
  }

  // Défaut constaté : `syncBannerFor` ne garde pendant le cycle suivant que les échecs (`trouble`) de la phase précédente ;
  // « En attente d'iCloud » est retiré au début de chaque cycle puis reposé à sa fin : clignotement toutes les 5 minutes tant que
  // iCloud est indisponible (le cycle dure plus de 1 s quand le fichier est en attente, et « Synchro en cours » le remplace). Corrigé : l'attente
  // est gardée pendant le cycle suivant comme les échecs.
  it('DÉFAUT QA-2 (corrigé) : « En attente d’iCloud » qui dure ne clignote pas entre deux cycles', async () => {
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    set({ phase: 'waiting-icloud', errorCode: 'cloud-provider-stopped' });
    const { seen, stop } = recordBanners();
    for (let i = 0; i < 2; i += 1) {
      set({ phase: 'syncing' });
      set({ phase: 'waiting-icloud', errorCode: 'cloud-provider-stopped' });
    }
    stop();
    expect(seen.includes(null), JSON.stringify(seen)).toBe(false);
  });
});

describe('accessibilité et textes (9 h, 9 j)', () => {
  it('un seul role="status", jamais role="alert" ni dialog, bouton nommé, texte seul quand il n’y a pas d’action', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    for (const { name, patch } of BLOCKED) {
      set(patch);
      expect(screen.getAllByRole('status'), name).toHaveLength(1);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      if (name === 'waiting-icloud') expect(screen.queryByRole('button')).toBeNull();
      else expect(screen.getAllByRole('button')).toHaveLength(1);
    }
  });

  it('« Voir » est un vrai bouton focalisable et ouvre Réglages › Synchronisation', async () => {
    render(<AppStatusBanner />);
    await start().refreshed();
    set({ phase: 'clock-ahead', clockAheadDevice: PHONE, devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'clock-ahead')] });
    const button = screen.getByRole('button', { name: 'Voir le problème de synchronisation' });
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'sync' });
  });

  it('anglais : le bandeau reprend mot pour mot la ligne de Réglages en anglais, et « View » remplace « Voir »', async () => {
    registerCatalog('en', en);
    setLocale('en');
    render(<AppStatusBanner />);
    await start().refreshed();
    for (const { name, patch } of BLOCKED) {
      set(patch);
      const line = statusLine(sync.status(), db.clock.nowMs());
      expect(banner()?.textContent, name).toContain(line);
      expect(line, name).not.toBe(statusLineFr(name));
      if (name !== 'waiting-icloud') expect(screen.getByRole('button', { name: 'View the sync problem' }).textContent).toBe('View');
    }
    set({ phase: 'waiting-icloud', errorCode: null });
    expect(text()).toBe(en.status.waitingIcloud);
    // L'attente reste pendant le cycle suivant (QA-2) : « Syncing » se lit après un cycle conclu « à jour ».
    set({ phase: 'idle', errorCode: null });
    set({ phase: 'syncing' });
    fireTimers();
    expect(text()).toBe(en.status.syncing);
  });

  it('textes du cadre : mêmes clés status.* en français et en anglais, mêmes paramètres, aucun vide', () => {
    const params = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    const frStatus = fr.status as Record<string, string>;
    const enStatus = en.status as Record<string, string>;
    expect(Object.keys(enStatus).sort()).toEqual(Object.keys(frStatus).sort());
    for (const key of Object.keys(frStatus)) {
      expect(frStatus[key], key).not.toBe('');
      expect(enStatus[key], key).not.toBe('');
      expect(params(enStatus[key] as string), key).toEqual(params(frStatus[key] as string));
    }
  });

  it('textes de Réglages repris par le bandeau : tout sync.status.* a les mêmes paramètres en français et en anglais', () => {
    const params = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    const frStatus = fr.sync.status as Record<string, string>;
    const enStatus = en.sync.status as Record<string, string>;
    for (const key of Object.keys(frStatus)) expect(params(enStatus[key] as string), key).toEqual(params(frStatus[key] as string));
  });

  it('dispose() retire chaque état posé, y compris « (+N) » et le bouton, et un état émis ensuite est ignoré', async () => {
    await db.data.repos.sync.setMeta(JOIN_STATE_META, JSON.stringify(JOIN));
    render(<AppStatusBanner />);
    await act(async () => {
      await start().refreshed();
    });
    set({ phase: 'restore-choice', devices: [device(SELF, 'windows', 'active', true), device(PHONE, 'ios', 'corrupt')] });
    await settle();
    expect(sources().syncTrouble?.more).toBe(2);
    act(() => integration?.dispose());
    expect(sources()).toEqual({});
    expect(banner()).toBeNull();
    set({ phase: 'error', errorCode: 'io' });
    expect(sources()).toEqual({});
  });
});

/** Texte français de la ligne de Réglages pour le cas nommé (référence de comparaison de la parité). */
function statusLineFr(name: string): string {
  const table: Record<string, string> = {
    error: fr.sync.status.errorFolderUnreachable,
    'key-mismatch': fr.sync.status.keyMismatch,
    'clock-ahead': fr.sync.status.clockAhead.replace('{device}', 'iPhone'),
    'needs-pairing': fr.sync.status.needsPairing,
    'restore-choice': fr.sync.status.restoreChoice,
    'waiting-icloud': fr.sync.status.errorCloudProviderStopped,
  };
  return table[name] ?? '';
}
