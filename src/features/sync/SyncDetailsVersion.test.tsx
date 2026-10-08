import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_STATUS_PRIORITY } from '../../domain/appStatus';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { SyncDetailsVersion } from './SyncDetailsVersion';
import { SyncStatusLine } from './SyncStatusLine';
import { SyncSettingsSection } from './SyncSettingsSection';
import { createMemorySyncPlatform } from '../../platform/sync/memory';
import { startSyncIntegration } from './startSync';
import { formatSyncTime } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/** Bandeau « Mettez à jour l'app », ligne de Réglages et emplacement « version » (Y-07 critères 8 à 11 ; critère 12 : tests/unit/sync/versions/texts.test.ts). */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d7');
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PC2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const NOW = '2026-10-05T08:02:00.000Z';

const self: SyncDeviceStatus = { deviceId: SELF, platform: 'windows', self: true, lastReadAt: NOW as IsoDateTime, status: 'active' };
const iphone = (extra: Partial<SyncDeviceStatus>): SyncDeviceStatus => ({ deviceId: IPHONE, platform: 'ios', self: false, lastReadAt: null, status: 'active', appVersion: '0.4.0', newer: null, ...extra });

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud', devices: [self] });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

const renderIn = (node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);
const banner = () => useAppStatusStore.getState().sources.updateRequired;

describe('emplacement « version » (Y-07 critère 10)', () => {
  it('absent quand tous les autres appareils ont la même version ou une plus ancienne', () => {
    sync.setStatus({ devices: [self, iphone({ newer: null })] });
    const { container: root } = renderIn(<SyncDetailsVersion />);
    expect(root.innerHTML).toBe('');
  });

  it('version de schéma plus récente : « iPhone utilise une version plus récente de l’app (0.5.0) », annoncé, sans numéro de migration', () => {
    sync.setStatus({ devices: [self, iphone({ newer: 'schema', appVersion: '0.5.0' })] });
    renderIn(<SyncDetailsVersion />);
    expect(screen.getByText('VERSION')).toBeTruthy();
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('iPhone utilise une version plus récente de l’app (0.5.0)');
    expect(region.textContent).not.toMatch(/\b1[78]\b/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('numéro inconnu : le texte seul (D2) ; majeure supérieure : lecture suspendue', () => {
    sync.setStatus({ devices: [self, iphone({ status: 'newer-major', newer: 'major', appVersion: null })] });
    renderIn(<SyncDetailsVersion />);
    const region = screen.getByRole('status');
    expect(within(region).getByText('iPhone utilise une version plus récente de l’app')).toBeTruthy();
    expect(within(region).getByText('Lecture de ses données suspendue : mettez à jour l’app')).toBeTruthy();
  });

  it('plusieurs appareils plus récents : chacun nommé comme dans APPAREILS ; un appareil absent ou oublié n’y figure pas', () => {
    sync.setStatus({
      devices: [
        self,
        iphone({ newer: 'schema', appVersion: '0.5.0' }),
        { deviceId: PC2, platform: 'windows', self: false, lastReadAt: null, status: 'active', appVersion: '0.6.0', newer: 'schema' },
        { deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId, platform: 'ios', self: false, lastReadAt: null, status: 'expired', appVersion: '0.6.0', newer: 'schema' },
      ],
    });
    renderIn(<SyncDetailsVersion />);
    const lines = [...screen.getByRole('status').querySelectorAll('.ct-sync__deviceName')].map((n) => n.textContent);
    expect(lines).toEqual(['iPhone bbbb utilise une version plus récente de l’app (0.5.0)', 'PC cccc utilise une version plus récente de l’app (0.6.0)']);
  });

  it('dans l’écran de détails, à sa place (entre l’état et APPAREILS)', () => {
    sync.setStatus({ devices: [self, iphone({ newer: 'schema', appVersion: '0.5.0' })] });
    renderIn(<SyncDetailsScreen />);
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf('VERSION')).toBeGreaterThan(headings.indexOf('ÉTAT'));
    expect(headings.indexOf('VERSION')).toBeLessThan(headings.indexOf('APPAREILS'));
  });
});

describe('ligne de Réglages (Y-07 critère 8)', () => {
  it('lecture suspendue : « Mettez à jour l’app pour lire les données de iPhone »', () => {
    sync.setStatus({ phase: 'update-required', devices: [self, iphone({ status: 'newer-major', newer: 'major' })] });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('Mettez à jour l’app pour lire les données de iPhone');
  });

  it('sans appareil identifiable : le texte général', () => {
    sync.setStatus({ phase: 'update-required', devices: [self] });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('Mettez à jour l’app pour lire les données de vos autres appareils');
  });
});

describe('bandeau A-09 « Mettez à jour l’app » (Y-07 critère 9)', () => {
  const start = () => startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined });

  it('actif tant qu’un appareil actif publie une version plus récente (sv ou sm) ; retiré quand il expire, est oublié, disparaît ou quand l’app est à jour', () => {
    const integration = start();
    sync.setStatus({ devices: [self, iphone({ newer: 'schema' })] });
    expect(banner()).toBeDefined();
    sync.setStatus({ devices: [self, iphone({ status: 'expired', newer: 'schema' })] });
    expect(banner()).toBeUndefined();
    sync.setStatus({ phase: 'update-required', devices: [self, iphone({ status: 'newer-major', newer: 'major' })] });
    expect(banner()).toBeDefined();
    sync.setStatus({ phase: 'idle', devices: [self, iphone({ status: 'forgotten', newer: 'major' })] });
    expect(banner()).toBeUndefined();
    sync.setStatus({ devices: [self, iphone({ newer: 'schema' })] });
    expect(banner()).toBeDefined();
    sync.setStatus({ devices: [self] });
    expect(banner()).toBeUndefined();
    sync.setStatus({ devices: [self, iphone({ newer: 'schema' })] });
    // Mise à jour de l'app locale : l'autre appareil n'est plus plus récent.
    sync.setStatus({ devices: [self, iphone({ newer: null })] });
    expect(banner()).toBeUndefined();
    sync.setStatus({ devices: [self, iphone({ newer: 'schema' })] });
    integration.dispose();
    expect(banner()).toBeUndefined();
  });

  it('aucun bandeau pour un appareil plus ancien, ni sans synchro configurée', () => {
    const integration = start();
    sync.setStatus({ devices: [self, iphone({ newer: null, appVersion: '0.3.0' })] });
    expect(banner()).toBeUndefined();
    sync.setStatus({ phase: 'not-configured', devices: [self, iphone({ newer: 'schema' })] });
    expect(banner()).toBeUndefined();
    sync.setStatus({ phase: 'needs-pairing', devices: [self, iphone({ newer: 'schema' })] });
    expect(banner()).toBeUndefined();
    integration.dispose();
    const plain = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data });
    startSyncIntegration(plain).dispose();
    expect(banner()).toBeUndefined();
  });

  it('priorité (D1, A-09 D1) : derrière « Agenda déconnecté » et un problème de synchro, devant « En attente d’iCloud », « Synchro en cours » et « Hors ligne » ; texte seul, aucun bouton', () => {
    expect(APP_STATUS_PRIORITY).toEqual(['calendarDisconnected', 'syncTrouble', 'remindersTrouble', 'updateRequired', 'waitingIcloud', 'syncing', 'offline']);
    render(<AppStatusBanner />);
    const set = useAppStatusStore.getState().setStatus;
    act(() => {
      set('updateRequired', {});
      set('waitingIcloud', {});
      set('syncing', {});
      set('offline', {});
    });
    expect(document.querySelectorAll('.ct-status-banner')).toHaveLength(1);
    expect(document.querySelector('.ct-status-banner')?.textContent).toBe('Mettez à jour l’app : un de vos appareils utilise une version plus récente');
    expect(screen.queryByRole('button')).toBeNull();
    act(() => set('calendarDisconnected', { detail: 'Perso', onAction: () => undefined }));
    expect(document.querySelector('.ct-status-banner')?.textContent).toContain('Agenda Perso déconnecté');
    act(() => set('calendarDisconnected', null));
    expect(document.querySelector('.ct-status-banner')?.textContent).toContain('Mettez à jour l’app');
  });

  it('la phase update-required reste réservée à la lecture suspendue (D4) : un sv supérieur donne le bandeau, pas la phase', () => {
    const integration = start();
    sync.setStatus({ phase: 'idle', devices: [self, iphone({ newer: 'schema' })] });
    expect(banner()).toBeDefined();
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('À jour · il y a 2 min');
    integration.dispose();
  });
});

describe('bandeau A-09 (Y-07 critère 9, QA)', () => {
  const start = () => startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined });

  it('jamais pour un appareil d’une autre clé (foreign), expiré ou oublié, même s’il garde un sv supérieur ; un second appareil plus récent actif le maintient', () => {
    const integration = start();
    const pc2 = (extra: Partial<SyncDeviceStatus>): SyncDeviceStatus => ({ ...iphone({}), deviceId: PC2, platform: 'windows', ...extra });
    for (const status of ['foreign', 'expired', 'forgotten'] as const) {
      sync.setStatus({ devices: [self, iphone({ status, newer: 'schema' })] });
      expect(banner()).toBeUndefined();
      sync.setStatus({ devices: [self, iphone({ status, newer: 'major' })] });
      expect(banner()).toBeUndefined();
    }
    sync.setStatus({ devices: [self, iphone({ status: 'expired', newer: 'schema' }), pc2({ newer: 'schema' })] });
    expect(banner()).toBeDefined();
    sync.setStatus({ devices: [self, iphone({ status: 'expired', newer: 'schema' }), pc2({ status: 'forgotten', newer: 'schema' })] });
    expect(banner()).toBeUndefined();
    integration.dispose();
  });

  it('l’arrêt de l’intégration retire le bandeau sans toucher « Hors ligne »', () => {
    const integration = start();
    useAppStatusStore.getState().setStatus('offline', {});
    sync.setStatus({ devices: [self, iphone({ newer: 'schema' })] });
    expect(banner()).toBeDefined();
    integration.dispose();
    expect(banner()).toBeUndefined();
    expect(useAppStatusStore.getState().sources.offline).toBeDefined();
  });
});

describe('échec de réintégration visible (exigence d’Ali, 2026-10-05)', () => {
  const failure = { fields: 3, tables: ['task', 'event'], at: '2026-10-05T07:30:00.000Z' as IsoDateTime, errors: ['DbError'] };
  const start = () => startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined });

  it('Bandeau et corrupt / rollback : décision de revue, un état non fiable ne déclenche pas le bandeau ; clock-ahead oui', () => {
    const integration = start();
    for (const status of ['corrupt', 'rollback'] as const) {
      sync.setStatus({ devices: [self, iphone({ status, newer: 'schema' })] });
      expect(banner(), status).toBeUndefined();
    }
    sync.setStatus({ devices: [self, iphone({ status: 'clock-ahead', newer: 'schema' })] });
    expect(banner()).toBeDefined();
    integration.dispose();
  });

  it('ligne de Réglages en état « problème » : « 3 éléments reçus d’une version plus récente n’ont pas pu être intégrés »', () => {
    sync.setStatus({ phase: 'idle', reintegrationFailure: failure });
    renderIn(<SyncStatusLine />);
    const line = screen.getByTestId('sync-status-text');
    expect(line.textContent).toBe('3 éléments reçus d’une version plus récente n’ont pas pu être intégrés');
    cleanup();
    sync.setStatus({ phase: 'idle', reintegrationFailure: { ...failure, fields: 1 } });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('1 élément reçu d’une version plus récente n’a pas pu être intégré');
    // Une erreur de synchro garde son texte (plus urgente).
    cleanup();
    sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable', reintegrationFailure: failure });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toContain('Dossier de synchro introuvable');
  });

  it('Détails, section VERSION : nombre, type d’élément, date du dernier essai, l’app réessaie à chaque démarrage ; annoncé, sans boîte', () => {
    sync.setStatus({ reintegrationFailure: failure });
    renderIn(<SyncDetailsVersion />);
    expect(screen.getByText('VERSION')).toBeTruthy();
    const region = screen.getByRole('status');
    expect(region.textContent).toContain('3 éléments non intégrés (tâches, événements)');
    expect(region.textContent).toContain(`Dernier essai : ${formatSyncTime(failure.at, db.clock.nowMs())}`);
    expect(region.textContent).toContain('L’app réessaie à chaque démarrage');
    expect(region.textContent).not.toContain('DbError');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('écran principal : bandeau A-09 de l’état le plus proche (updateRequired) avec le texte de l’échec ; retiré quand l’échec s’efface', () => {
    const integration = start();
    sync.setStatus({ reintegrationFailure: failure });
    expect(banner()).toEqual({ detail: 'reintegration' });
    render(<AppStatusBanner />);
    expect(document.querySelector('.ct-status-banner')?.textContent).toBe('Des éléments reçus n’ont pas pu être intégrés : voir Réglages › Synchronisation');
    act(() => sync.setStatus({ reintegrationFailure: null }));
    expect(banner()).toBeUndefined();
    integration.dispose();
  });

  it('aucun échec (null ou absent) : rien d’affiché nulle part', () => {
    const integration = start();
    sync.setStatus({ reintegrationFailure: null });
    const { container: root } = renderIn(<SyncDetailsVersion />);
    expect(root.innerHTML).toBe('');
    expect(banner()).toBeUndefined();
    integration.dispose();
  });
});

describe('synchro non configurée avec un échec enregistré (revue 2, point 4)', () => {
  const failure = { fields: 2, tables: [], at: '2026-10-05T07:30:00.000Z' as IsoDateTime, errors: ['DbError'] };

  it('Réglages : la section SYNCHRONISATION « Non configurée » montre quand même la ligne d’échec ; la ligne d’état aussi', async () => {
    sync.setStatus({ phase: 'not-configured', devices: [], reintegrationFailure: failure });
    renderIn(<SyncSettingsSection platform={createMemorySyncPlatform()} />);
    expect(await screen.findByText('2 éléments reçus d’une version plus récente n’ont pas pu être intégrés')).toBeTruthy();
    expect(screen.getByText('2 éléments reçus d’une version plus récente n’ont pas pu être intégrés').getAttribute('role')).toBe('status');
    cleanup();
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('2 éléments reçus d’une version plus récente n’ont pas pu être intégrés');
  });

  it('bandeau : l’échec reste signalé sans synchro configurée ; un appareil plus récent, non', () => {
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined });
    sync.setStatus({ phase: 'not-configured', devices: [self, iphone({ newer: 'schema' })], reintegrationFailure: null });
    expect(banner()).toBeUndefined();
    sync.setStatus({ phase: 'not-configured', reintegrationFailure: failure });
    expect(banner()).toEqual({ detail: 'reintegration' });
    integration.dispose();
  });

  it('sans échec, la section non configurée ne montre rien de plus', async () => {
    sync.setStatus({ phase: 'not-configured', devices: [], reintegrationFailure: null });
    renderIn(<SyncSettingsSection platform={createMemorySyncPlatform()} />);
    expect(await screen.findByTestId('sync-folder-state')).toBeTruthy();
    expect(screen.queryByText(/n’ont pas pu être intégrés|n’a pas pu être intégré/)).toBeNull();
  });
});
