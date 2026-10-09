// @vitest-environment jsdom
// Y-IOS-02, revue de la PR #17 : signet perdu sur l'iPhone (« Choisir le dossier » dans Détails) ; clé illisible alors que la synchro est à
// jour : ligne explicite avec « Réessayer » (jamais un QR qui disparaît sans explication), clé relue au retour au premier plan.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from '../../platform/sync';
import type { SyncStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer } from '../app/container';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000e1');
const NOW = '2026-10-09T08:00:00.000Z';
const CHOOSE = 'Choisir le dossier de synchronisation';
const SHOW_QR = 'Associer l’iPhone : afficher le code d’association';
const UNREADABLE = 'Clé de chiffrement illisible pour l’instant : déverrouillez l’appareil, puis réessayez';
const REREAD = 'Relire la clé de chiffrement';

let db: TestDb;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
});

afterEach(async () => {
  cleanup();
  await db.close();
});

async function withKey(os: 'ios' | 'windows'): Promise<MemorySyncPlatform> {
  const platform = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), platform: os });
  await platform.folder.choose();
  await platform.key.create();
  await platform.bindDevice(SELF);
  return platform;
}

function show(platform: MemorySyncPlatform, os: 'ios' | 'windows', status: Partial<SyncStatus>): void {
  const sync = createFakeSyncService({ folderLabel: 'CircleTasks', folderKind: 'icloud', lastSyncAt: '2026-10-09T07:59:00.000Z' as IsoDateTime, ...status });
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, syncPlatform: platform, platform: { runtime: 'tauri', os } });
  render(
    <AppContainerProvider container={container}>
      <SyncDetailsScreen />
    </AppContainerProvider>,
  );
}

describe('signet perdu (folder-unreachable) : « Choisir le dossier » dans Détails', () => {
  it('iPhone : proposé (le texte demande de choisir de nouveau le dossier)', async () => {
    show(await withKey('ios'), 'ios', { phase: 'error', errorCode: 'folder-unreachable' });
    expect(await screen.findByRole('button', { name: CHOOSE })).toBeInTheDocument();
  });

  it('PC : non proposé (dossier introuvable un moment, vos modifications seront envoyées au retour)', async () => {
    show(await withKey('windows'), 'windows', { phase: 'error', errorCode: 'folder-unreachable' });
    expect(await screen.findByTestId('sync-status-text')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CHOOSE })).toBeNull();
  });
});

describe('clé illisible alors que la synchro est à jour', () => {
  it('PC : ligne « illisible pour l’instant » avec « Réessayer » au lieu du QR ; relue : QR de retour, ligne retirée', async () => {
    const platform = await withKey('windows');
    platform.testing.setVaultAvailable(false);
    show(platform, 'windows', { phase: 'idle' });
    expect(await screen.findByText(UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SHOW_QR })).toBeNull();
    platform.testing.setVaultAvailable(true);
    fireEvent.click(screen.getByRole('button', { name: REREAD }));
    expect(await screen.findByRole('button', { name: SHOW_QR })).toBeInTheDocument();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });

  it('retour au premier plan : la clé est relue sans action (iPhone déverrouillé)', async () => {
    const platform = await withKey('ios');
    platform.testing.setVaultAvailable(false);
    show(platform, 'ios', { phase: 'idle' });
    expect(await screen.findByText(UNREADABLE)).toBeInTheDocument();
    platform.testing.setVaultAvailable(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByTestId('sync-key-id')).toBeInTheDocument();
    expect(screen.queryByText(UNREADABLE)).toBeNull();
  });
});
