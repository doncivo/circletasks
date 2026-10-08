// @vitest-environment jsdom
// Y-IOS-02 critères 7, 8, 14 et 16 (ADR 0011 §23 points 2, 6 et 7) : écran « Associer au PC » de l'iPhone (dossier d'abord, explication de
// la caméra, scan, réception, progression ; clé de secours à la place ; caméra refusée visible ; refus gardé jusqu'à la réussite ; jamais
// de QR), ligne de Réglages, étape « Synchronisation » de l'assistant, échec de réintégration sur iPhone (visible, persistant, effacé).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { REINTEGRATION_FAILURE_META } from '../../domain/sync/compat';
import { asEntityId, type DeviceId, type Hlc } from '../../domain/types';
import type { DeviceAck, EpochId } from '../../domain/sync/format';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from '../../platform/sync';
import { createSyncService, silentSyncLogger } from '../../sync';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { onboardingCapabilities } from '../settings/onboardingStore';
import { IosPairingScreen } from './IosPairingScreen';
import { startSyncIntegration } from './startSync';
import { SyncSettingsSection } from './SyncSettingsSection';
import { createFakeSyncService, nextCall, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PC = '70000000-0000-4000-8000-000000000008' as DeviceId;
const NOW = '2026-10-08T08:00:00.000Z';

let db: TestDb;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService();
});

afterEach(async () => {
  cleanup();
  document.documentElement.classList.remove('ct-scanning');
  await db.close();
});

function phoneContainer(syncPlatform: MemorySyncPlatform | null, service: FakeSyncService | null = sync): AppContainer {
  return createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync: service, syncPlatform, platform: { runtime: 'tauri', os: 'ios' } });
}

/** Le PC a créé la clé et publié dans le dossier partagé ; l'iPhone l'a choisi (ou pas), sans clé. */
async function pcAndPhone(chosen: boolean): Promise<{ pc: MemorySyncPlatform; phone: MemorySyncPlatform; qr: () => Promise<string>; folder: MemorySyncFolder }> {
  const folder = new MemorySyncFolder('icloud');
  const pc = createMemorySyncPlatform({ folder, nowMs: () => db.clock.nowMs() });
  await pc.folder.choose();
  await pc.key.create();
  await pc.bindDevice(PC);
  const epoch = `e0001-${PC}` as EpochId;
  const hlc = `000001759651200-0000-${PC}` as Hlc;
  await pc.appendJournal({ epoch, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc, records: ['{}'] });
  await pc.writeState({
    sv: 14,
    state: { deviceId: PC, platform: 'windows', appVersion: '0.1.1', sm: 1, sv: 14, epoch, stateSeq: 1, head: { epoch, segment: 1, record: 1, hlc, stateSeq: 1 }, acks: new Map<DeviceId, DeviceAck>(), snapshot: null, purgeHorizon: null, lastSyncHlc: hlc, forgotten: [], reset: null },
  });
  const phone = createMemorySyncPlatform({ folder, platform: 'ios', nowMs: () => db.clock.nowMs() });
  if (!chosen) phone.testing.setChooser(folder);
  if (chosen) {
    await phone.folder.choose();
    await phone.bindDevice(SELF);
  }
  const qr = async (): Promise<string> => {
    await pc.key.openPairing('show');
    const { qrText } = await pc.key.pairingPayload();
    await pc.key.closePairing();
    return qrText;
  };
  return { pc, phone, qr, folder };
}

function renderScreen(phone: MemorySyncPlatform, container = phoneContainer(phone)): { closed: () => number } {
  let closed = 0;
  render(
    <AppContainerProvider container={container}>
      <IosPairingScreen platform={phone} onClose={() => (closed += 1)} />
    </AppContainerProvider>,
  );
  return { closed: () => closed };
}

const scanButton = () => screen.findByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' });

describe('écran « Associer au PC » (Y-IOS-02 critère 7)', () => {
  it('dossier d’abord : choix du dossier, puis explication de la caméra et scan ; jamais de QR affiché', async () => {
    const { phone } = await pcAndPhone(false);
    renderScreen(phone);
    expect(await screen.findByText('Choisissez d’abord le même dossier iCloud Drive / CircleTasks que sur le PC.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choisir le dossier iCloud Drive / CircleTasks' }));
    expect(await scanButton()).toBeInTheDocument();
    expect(screen.getByText(/CircleTasks utilise la caméra pour scanner le code d’association/)).toBeInTheDocument();
    expect((await phone.folder.info()).configured).toBe(true);
    expect(screen.queryByRole('img', { name: /QR/ })).toBeNull();
  });

  it('scan : texte fourni par le faux (jamais par la page), clé reçue, cycle lancé, progression ; « Fermer »', async () => {
    const { phone, qr } = await pcAndPhone(true);
    phone.testing.setCameraPermission('prompt', 'granted');
    phone.testing.setScanResult(await qr());
    const view = renderScreen(phone);
    const synced = nextCall(sync, 'syncNow');
    fireEvent.click(await scanButton());
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
    await synced;
    expect(sync.calls).toContain('manual');
    expect((await phone.key.status()).present).toBe(true);
    expect(document.body.textContent).not.toContain('CTPAIR1');
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(view.closed()).toBe(1);
  });

  it('caméra refusée : dit, « Ouvrir les réglages », relue au retour au premier plan', async () => {
    const { phone } = await pcAndPhone(true);
    phone.testing.setCameraPermission('denied');
    renderScreen(phone);
    expect(await screen.findByTestId('ios-camera-denied')).toHaveTextContent('L’accès à la caméra est refusé');
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir les réglages d’iOS pour autoriser la caméra' }));
    expect(phone.testing.cameraSettingsOpened()).toBe(1);
    phone.testing.setCameraPermission('granted');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await phone.key.cameraPermission?.();
    });
    expect(await scanButton()).toBeInTheDocument();
    expect(screen.queryByTestId('ios-camera-denied')).toBeNull();
  });

  it('remplacement de clé refusé (critère 14) : message gardé jusqu’à la tentative réussie suivante', async () => {
    const { phone, qr, folder } = await pcAndPhone(false);
    // Une autre clé est déjà là (créée sur un autre dossier, gardée à l'oubli du dossier) : confirmation native demandée, et refusée.
    phone.testing.setChooser(new MemorySyncFolder('autre'));
    await phone.folder.choose();
    await phone.key.create();
    const before = (await phone.key.status()).kid;
    await phone.folder.forget({ eraseKey: false });
    phone.testing.setChooser(folder);
    await phone.folder.choose();
    await phone.bindDevice(SELF);
    phone.testing.setConsent(false);
    phone.testing.setScanResult(await qr());
    renderScreen(phone);
    fireEvent.click(await scanButton());
    expect(await screen.findByTestId('ios-pairing-message')).toHaveTextContent('Confirmation refusée : la clé de cet iPhone n’a pas été remplacée');
    expect((await phone.key.status()).kid).toBe(before);
    // Gardé : rien d'autre ne l'efface tant qu'aucune tentative ne réussit ; la tentative réussie suivante le retire.
    expect(screen.getByTestId('ios-pairing-message')).toBeInTheDocument();
    // Pendant le blocage de 10 minutes qui suit un refus : « Trop de tentatives », toujours dit.
    phone.testing.setConsent(true);
    phone.testing.setScanResult(await qr());
    fireEvent.click(await scanButton());
    expect(await screen.findByText('Trop de tentatives : réessayez dans 10 minutes')).toBeInTheDocument();
    db.clock.advance(10 * 60_000);
    phone.testing.setScanResult(await qr());
    fireEvent.click(await scanButton());
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
    expect(screen.queryByTestId('ios-pairing-message')).toBeNull();
  });

  it('« Saisir la clé de secours à la place » : saisie existante dans la fenêtre principale, vidée après envoi', async () => {
    const { phone, pc } = await pcAndPhone(true);
    await pc.key.openPairing('show');
    const { recoveryKey } = await pc.key.pairingPayload();
    await pc.key.closePairing();
    renderScreen(phone);
    fireEvent.click(await screen.findByRole('button', { name: 'Saisir la clé de secours imprimée à la place du code' }));
    const field = await screen.findByLabelText('Clé de secours');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    fireEvent.change(field, { target: { value: recoveryKey } });
    fireEvent.click(screen.getByRole('button', { name: 'Associer' }));
    expect(await screen.findByText('Cet iPhone est associé au PC')).toBeInTheDocument();
    expect((await phone.key.status()).present).toBe(true);
  });
});

describe('Réglages de l’iPhone (Y-IOS-02 critères 6 et 7)', () => {
  it('à associer : ligne « Associer au PC » ; caméra refusée dite sur la ligne avec « Ouvrir les réglages »', async () => {
    const { phone } = await pcAndPhone(true);
    phone.testing.setCameraPermission('denied');
    render(
      <AppContainerProvider container={phoneContainer(phone, null)}>
        <SyncSettingsSection platform={phone} />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Associer cet iPhone au PC : scanner le code d’association' })).toBeInTheDocument();
    expect(await screen.findByTestId('sync-camera-denied')).toHaveTextContent('L’accès à la caméra est refusé');
    expect(screen.getByRole('button', { name: 'Ouvrir les réglages d’iOS pour autoriser la caméra' })).toBeInTheDocument();
    // Jamais la fenêtre `pairing` du PC sur l'iPhone.
    expect(screen.queryByRole('button', { name: 'Associer cet appareil avec la clé de secours' })).toBeNull();
  });
});

describe('assistant de premier lancement (Y-IOS-02 critère 8)', () => {
  it('iPhone, synchro disponible : étape « Synchronisation » (4 étapes) ; indisponible : 3 étapes', () => {
    const available = phoneContainer(createMemorySyncPlatform({ platform: 'ios' }));
    expect(onboardingCapabilities(available).pairing).toBe(true);
    const unavailable = phoneContainer(createMemorySyncPlatform({ platform: 'ios', available: false }));
    expect(onboardingCapabilities(unavailable).pairing).toBe(false);
  });
});

describe('échec de réintégration sur iPhone (ADR 0011 §23 point 6 ; Y-IOS-02 critère 16)', () => {
  const failure = { fields: 3, tables: ['task'], at: NOW, errors: ['UnknownColumn'] };

  async function phoneService(): Promise<{ service: ReturnType<typeof createSyncService>; container: AppContainer }> {
    const platform = createMemorySyncPlatform({ platform: 'ios', nowMs: () => db.clock.nowMs() });
    const service = createSyncService({ data: db.data, platform, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), clock: db.clock, deviceId: SELF, devicePlatform: 'ios', sv: 14, logger: silentSyncLogger, setTimeout: () => 0, clearTimeout: () => undefined });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync: service, syncPlatform: platform, platform: { runtime: 'tauri', os: 'ios' } });
    return { service, container };
  }

  it('visible (bandeau « Mettez à jour l’app »), persistant après redémarrage, effacé à la réussite', async () => {
    await db.data.repos.sync.setMeta(REINTEGRATION_FAILURE_META, JSON.stringify(failure));
    const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
    const first = await phoneService();
    const integration = startSyncIntegration(first.container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await first.service.syncNow('manual');
    await integration.refreshed();
    expect(first.service.status().reintegrationFailure).toEqual(failure);
    expect(useAppStatusStore.getState().sources.updateRequired?.detail).toBe('reintegration');
    integration.dispose();
    // Redémarrage : même base, nouveau service ; l'échec revient au premier cycle.
    const second = await phoneService();
    await second.service.syncNow('open');
    expect(second.service.status().reintegrationFailure).toEqual(failure);
    // Réintégration réussie : effacé.
    await db.data.repos.sync.setMeta(REINTEGRATION_FAILURE_META, null);
    await second.service.syncNow('manual');
    expect(second.service.status().reintegrationFailure ?? null).toBeNull();
  });
});
