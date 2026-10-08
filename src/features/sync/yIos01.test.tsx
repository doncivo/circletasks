// @vitest-environment jsdom
// Y-IOS-01 critères 8, 12 et 13 (ADR 0011 §22 points 7 et 8) : synchro visible sur iPhone, signet perdu visible et persistant (Réglages,
// Détails, bandeau A-09, après un redémarrage), effacé au nouveau choix du dossier ; sélecteur annulé sans erreur ; actions qui demandent
// une confirmation native : masquées jusqu'à Y-IOS-02, proposées depuis (`UIAlertController`, ADR 0011 §23 point 5).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemorySyncPlatform, SyncPlatformError, type SyncFolderInfo, type SyncPlatform } from '../../platform/sync';
import type { SyncDeviceStatus, SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { AppStatusBanner } from '../app/AppStatusBanner';
import { createAppContainer, type AppContainer } from '../app/container';
import { BLOCKING_PHASE_META, startSyncIntegration, type SyncIntegration } from './startSync';
import { SyncDeviceForgetAction } from './SyncDetailsForget';
import { SyncSettingsSection } from './SyncSettingsSection';
import { statusLine } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PC = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const NOW = '2026-10-08T08:00:00.000Z';
const IOS_TEXT = 'Dossier iCloud Drive inaccessible : choisissez de nouveau le dossier iCloud Drive / CircleTasks';
const IPHONE_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const self = (platform: 'ios' | 'windows'): SyncDeviceStatus => ({ deviceId: SELF, platform, self: true, status: 'active', lastReadAt: null });
const other: SyncDeviceStatus = { deviceId: PC, platform: 'windows', self: false, status: 'active', lastReadAt: null };

let db: TestDb;
let sync: FakeSyncService;
let integration: SyncIntegration | null = null;

function phone(service: FakeSyncService | null, syncPlatform: SyncPlatform | null = null): AppContainer {
  return createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync: service, syncPlatform, platform: { runtime: 'tauri', os: 'ios' } });
}

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;

function start(container: AppContainer): SyncIntegration {
  integration = startSyncIntegration(container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
  return integration;
}

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService();
});

afterEach(async () => {
  integration?.dispose();
  integration = null;
  cleanup();
  vi.restoreAllMocks();
  await db.close();
});

describe('textes de l’iPhone (ADR 0011 §22 point 8)', () => {
  it('signet perdu : texte propre à l’iPhone ; PC : texte inchangé', () => {
    const base = { phase: 'error', errorCode: 'folder-unreachable' } as const;
    const status = (platform: 'ios' | 'windows'): SyncStatus => ({ ...sync.status(), ...base, devices: [self(platform), other] });
    expect(statusLine(status('ios'), Date.parse(NOW))).toBe(IOS_TEXT);
    expect(statusLine(status('windows'), Date.parse(NOW))).toBe('Dossier de synchro introuvable : vos modifications seront envoyées au retour');
    // Avant le premier cycle conclu (aucune ligne APPAREILS) : le système détecté.
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_AGENT);
    expect(statusLine({ ...sync.status(), ...base, devices: [] }, Date.parse(NOW))).toBe(IOS_TEXT);
  });
});

describe('Y-IOS-01 critère 12 : signet perdu visible et persistant', () => {
  it('bandeau A-09 au texte de l’iPhone, gardé après un redémarrage, effacé au premier cycle réussi', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_AGENT);
    const container = phone(sync);
    render(<AppStatusBanner />);
    await start(container).refreshed();
    act(() => sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable', devices: [self('ios')] }));
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toBe(IOS_TEXT);
    expect(JSON.parse((await db.data.repos.sync.getMeta(BLOCKING_PHASE_META)) ?? 'null')).toMatchObject({ phase: 'error', errorCode: 'folder-unreachable' });

    // Redémarrage : nouveau service (aucun cycle encore), même base : le bandeau revient avant tout cycle.
    integration?.dispose();
    sync = createFakeSyncService();
    await start(phone(sync)).refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toBe(IOS_TEXT);
    expect(screen.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeTruthy();

    // Dossier choisi de nouveau, cycle réussi : effacé, et la valeur gardée aussi.
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, devices: [self('ios')] }));
    await integration?.refreshed();
    expect(useAppStatusStore.getState().sources.syncTrouble).toBeUndefined();
    expect(await db.data.repos.sync.getMeta(BLOCKING_PHASE_META)).toBeNull();
  });

  it('Réglages : texte de l’iPhone et « Choisir le dossier » ; le nouveau choix rétablit le dossier', async () => {
    const memory = createMemorySyncPlatform({ platform: 'ios' });
    await memory.folder.choose();
    await memory.key.create();
    let lost = true;
    const platform: SyncPlatform = {
      ...memory,
      folder: {
        ...memory.folder,
        info: async (): Promise<SyncFolderInfo> => {
          if (lost) throw new SyncPlatformError('folder-unreachable');
          return memory.folder.info();
        },
        choose: async () => {
          lost = false;
          return memory.folder.choose();
        },
      },
    };
    render(
      <AppContainerProvider container={phone(null)}>
        <SyncSettingsSection platform={platform} />
      </AppContainerProvider>,
    );
    expect(await screen.findByText(IOS_TEXT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oublier le dossier de synchronisation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByText('iCloud Drive / CircleTasks')).toBeInTheDocument();
    expect(screen.queryByText(IOS_TEXT)).toBeNull();
  });
});

describe('Y-IOS-01 critère 13 : sélecteur annulé', () => {
  it('« Choisir le dossier » annulé : rien ne change, aucune erreur', async () => {
    const platform = createMemorySyncPlatform({ platform: 'ios' });
    platform.testing.setChooser(null);
    render(
      <AppContainerProvider container={phone(null)}>
        <SyncSettingsSection platform={platform} />
      </AppContainerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' }));
    expect(await screen.findByText('Non configurée')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('ADR 0011 §23 point 5 (Y-IOS-02) : actions à confirmation native proposées sur iPhone', () => {
  it('« Oublier » propose le dossier, et le dossier et la clé ; « Oublier cet appareil » proposé', async () => {
    const platform = createMemorySyncPlatform({ platform: 'ios' });
    await platform.folder.choose();
    await platform.key.create();
    const container = phone(sync, platform);
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, devices: [self('ios'), other] }));
    render(
      <AppContainerProvider container={container}>
        <SyncSettingsSection platform={platform} />
        <SyncDeviceForgetAction device={other} />
      </AppContainerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Oublier le dossier de synchronisation' }));
    expect(screen.getByRole('button', { name: 'Oublier le dossier' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oublier le dossier et la clé' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oublier PC' })).toBeInTheDocument();
  });

  it('témoin : sur PC, « Oublier cet appareil » est proposé', () => {
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, platform: { runtime: 'tauri', os: 'windows' } });
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, devices: [self('windows'), { ...other, platform: 'ios' }] }));
    render(
      <AppContainerProvider container={container}>
        <SyncDeviceForgetAction device={{ ...other, platform: 'ios' }} />
      </AppContainerProvider>,
    );
    expect(screen.getByRole('button', { name: 'Oublier iPhone' })).toBeInTheDocument();
  });
});
