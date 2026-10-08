// @vitest-environment jsdom
// Y-IOS-02 (point de contrôle d'Ali, IPA 0.2.1) : un appareil sans clé propose toujours l'association, jamais « Synchroniser » ni
// « Réinitialiser la synchronisation » ; APPAREILS expliqué ; sur le PC, « Associer l'iPhone » est directement dans Réglages › Synchronisation.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { DeviceAck, EpochId } from '../../domain/sync/format';
import { asEntityId, type DeviceId, type Hlc, type IsoDateTime } from '../../domain/types';
import { DbError } from '../../db/driver';
import type { DataAccess } from '../../db/repositories';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createManualClock } from '../../domain/clock';
import { isPermanentSyncError } from '../../domain/sync/errorFamily';
import { SYNC_ERROR_CODES } from '../../domain/sync/format';
import { createMemorySyncPlatform, MemorySyncFolder, SyncPlatformError, type MemorySyncPlatform, type SyncPlatform } from '../../platform/sync';
import { INITIAL_STATUS, type SyncErrorCode, type SyncReason, type SyncStatus } from '../../platform/sync/types';
import { createSyncService, silentSyncLogger, startSyncScheduler } from '../../sync';
import { statusLine } from './syncText';
import { syncFolderEn } from '../../i18n/en.syncFolder';
import { syncPairingEn, syncPairingWindowEn } from '../../i18n/en.syncPairing';
import { syncFolderFr } from '../../i18n/fr.syncFolder';
import { syncPairingFr, syncPairingWindowFr } from '../../i18n/fr.syncPairing';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { startSyncIntegration } from './startSync';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { SyncSettingsSection } from './SyncSettingsSection';
import { createFakeSyncService } from './testKit';

const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000c1');
const PC = '70000000-0000-4000-8000-00000000000a' as DeviceId;
const NOW = '2026-10-08T08:00:00.000Z';
const IPHONE_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const ASSOCIATE_PC = 'Associer cet iPhone au PC : scanner le code d’association';
const RESET = 'Réinitialiser la synchronisation avec une nouvelle clé';
const SHOW_QR = 'Associer l’iPhone : afficher le code d’association';

let db: TestDb;

beforeEach(async () => {
  db = await openTestDb(PHONE, NOW);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

/** Dossier partagé où le PC a publié sous sa clé ; un second appareil (`kind`) a choisi le dossier sans clé. */
async function folderFromPc(kind: 'ios' | 'windows'): Promise<MemorySyncPlatform> {
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
    state: { deviceId: PC, platform: 'windows', appVersion: '0.2.1', sm: 1, sv: 14, epoch, stateSeq: 1, head: { epoch, segment: 1, record: 1, hlc, stateSeq: 1 }, acks: new Map<DeviceId, DeviceAck>(), snapshot: null, purgeHorizon: null, lastSyncHlc: hlc, forgotten: [], reset: null },
  });
  const other = createMemorySyncPlatform({ folder, platform: kind, nowMs: () => db.clock.nowMs() });
  other.testing.setChooser(folder);
  return other;
}

/** `sync_meta` illisible (« database is locked », base de 0.2.1 sur l'iPhone) pendant les cycles. */
function lockedData(): DataAccess {
  const sync = db.data.repos.sync;
  const locked = new Proxy(sync, {
    get(target, prop, receiver) {
      if (prop === 'getMeta') return () => Promise.reject(new DbError('busy', 'database is locked'));
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...db.data, repos: { ...db.data.repos, sync: locked } };
}

function realContainer(platform: MemorySyncPlatform, os: 'ios' | 'windows', data: DataAccess = db.data): AppContainer {
  const service = createSyncService({ data, platform, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), clock: db.clock, deviceId: PHONE, devicePlatform: os, sv: 14, logger: silentSyncLogger, setTimeout: () => 0, clearTimeout: () => undefined });
  return createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync: service, syncPlatform: platform, platform: { runtime: 'tauri', os: os === 'ios' ? 'ios' : 'windows' } });
}

const renderIn = (container: AppContainer, node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);

const fakeDocument = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;

describe('iPhone sans clé : « Associer au PC » ne disparaît jamais (constat A)', () => {
  it('choix du dossier, cycles (base occupée comprise) : ligne de Réglages et Détails proposent « Associer au PC », bandeau A-09 « associez »', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE_AGENT);
    const phone = await folderFromPc('ios');
    const container = realContainer(phone, 'ios', lockedData());
    const integration = startSyncIntegration(container, { document: fakeDocument, setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    renderIn(container, <SyncSettingsSection />);
    const choose = await screen.findByRole('button', { name: 'Choisir le dossier de synchronisation' });
    await act(async () => {
      choose.click();
      await Promise.resolve();
    });
    expect(await screen.findByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ASSOCIATE_PC })).toBeInTheDocument();

    // Cycles d'ouverture et manuel : l'état reste « à associer », jamais « La synchronisation a échoué ».
    await act(async () => {
      await container.sync?.syncNow('open');
      await container.sync?.syncNow('manual');
      await integration.refreshed();
    });
    expect(container.sync?.status().phase).toBe('needs-pairing');
    expect(screen.getByRole('button', { name: ASSOCIATE_PC })).toBeInTheDocument();
    expect(screen.getByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeInTheDocument();
    expect(screen.queryByText('La synchronisation a échoué : nouvel essai au prochain cycle')).toBeNull();
    expect(useAppStatusStore.getState().sources.syncTrouble?.message).toBe('Associez cet iPhone au PC pour synchroniser');
    cleanup();

    // Détails : « Associer au PC », ni « Synchroniser » ni « Réinitialiser » ; APPAREILS expliqué.
    renderIn(container, <SyncDetailsScreen />);
    expect(await screen.findByRole('button', { name: ASSOCIATE_PC })).toBeInTheDocument();
    expect(screen.getByTestId('sync-status-text')).toHaveTextContent('Associez cet iPhone au PC pour synchroniser');
    expect(screen.queryByRole('button', { name: 'Synchroniser' })).toBeNull();
    expect(screen.queryByRole('button', { name: RESET })).toBeNull();
    expect(screen.getByTestId('sync-devices-empty')).toHaveTextContent('Associez cet iPhone pour voir les autres appareils');
    integration.dispose();
  });

  it('Détails, état d’erreur ancien mais clé absente du Trousseau : « Associer au PC », jamais « Réinitialiser » (constat C)', async () => {
    const phone = await folderFromPc('ios');
    await phone.folder.choose();
    await phone.bindDevice(PHONE);
    const sync = createFakeSyncService({ phase: 'error', errorCode: 'io', folderLabel: 'CircleTasks', folderKind: 'icloud', lastSyncAt: '2026-10-08T07:00:00.000Z' as IsoDateTime });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync, syncPlatform: phone, platform: { runtime: 'tauri', os: 'ios' } });
    renderIn(container, <SyncDetailsScreen />);
    expect(await screen.findByRole('button', { name: ASSOCIATE_PC })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RESET })).toBeNull();
  });

  it('PC sans clé : « Réinitialiser » jamais proposé, même en phase d’erreur ; avec la clé, proposé', async () => {
    const pcLike = await folderFromPc('windows');
    await pcLike.folder.choose();
    await pcLike.bindDevice(PHONE);
    const sync = createFakeSyncService({ phase: 'error', errorCode: 'io', folderLabel: 'CircleTasks', folderKind: 'icloud' });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync, syncPlatform: pcLike });
    renderIn(container, <SyncDetailsScreen />);
    expect(await screen.findByRole('button', { name: 'Associer cet appareil avec la clé de secours' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: RESET })).toBeNull();
    expect(screen.queryByRole('button', { name: SHOW_QR })).toBeNull();
  });
});

describe('PC : « Associer l’iPhone » dans Réglages › Synchronisation (constat B)', () => {
  it('dossier et clé : le bouton est sur la section de Réglages, pas seulement dans Détails', async () => {
    const pc = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud') });
    await pc.folder.choose();
    await pc.key.create();
    await pc.bindDevice(PHONE);
    const sync = createFakeSyncService({ phase: 'idle', folderLabel: 'CircleTasks', folderKind: 'icloud', lastSyncAt: '2026-10-08T07:59:00.000Z' as IsoDateTime });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync, syncPlatform: pc });
    renderIn(container, <SyncSettingsSection />);
    expect(await screen.findByRole('button', { name: SHOW_QR })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: SHOW_QR })).toHaveLength(1);
  });

  it('iPhone : jamais « Associer l’iPhone » (aucun QR sur l’iPhone)', async () => {
    const phone = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), platform: 'ios' });
    await phone.folder.choose();
    await phone.key.create();
    await phone.bindDevice(PHONE);
    const sync = createFakeSyncService({ phase: 'idle', folderLabel: 'CircleTasks', folderKind: 'icloud', lastSyncAt: '2026-10-08T07:59:00.000Z' as IsoDateTime });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync, syncPlatform: phone, platform: { runtime: 'tauri', os: 'ios' } });
    renderIn(container, <SyncSettingsSection />);
    expect(await screen.findByRole('button', { name: 'Détails' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: SHOW_QR })).toBeNull();
  });
});

describe('chemins d’association dits à l’utilisateur = libellés réels des boutons (constat B)', () => {
  it('iPhone → « Sur le PC : Réglages → Synchronisation → Associer l’iPhone » ; fenêtre du PC → « … → Associer au PC » (FR et EN)', () => {
    for (const [texts, window, folder] of [
      [syncPairingFr, syncPairingWindowFr, syncFolderFr],
      [syncPairingEn, syncPairingWindowEn, syncFolderEn],
    ] as const) {
      const section = folder.sectionTitle.charAt(0) + folder.sectionTitle.slice(1).toLowerCase();
      expect(texts.ios.hint).toContain(`${section} → ${texts.show}.`);
      expect(window.window.step1Path).toContain(`${section} → ${texts.ios.open}`);
    }
  });
});

describe('erreurs permanentes : jamais « nouvel essai au prochain cycle » (audit des impasses, F)', () => {
  const GENERIC = 'La synchronisation a échoué : nouvel essai au prochain cycle';
  const lineFor = (code: SyncErrorCode): string => statusLine({ ...INITIAL_STATUS, phase: 'error', errorCode: code, devices: [] }, Date.parse(NOW));

  it('chaque code de SYNC_ERROR_CODES : un code permanent dit son action et son code ; seul un code passager promet un nouvel essai', () => {
    for (const code of SYNC_ERROR_CODES) {
      if (!isPermanentSyncError(code)) continue;
      expect(lineFor(code), code).not.toBe(GENERIC);
      expect(lineFor(code), code).not.toContain('nouvel essai');
    }
    for (const code of ['io', 'decrypt-failed', 'key-exhausted', 'not-bound', 'segment-full', 'hlc-order'] as const) {
      expect(isPermanentSyncError(code), code).toBe(true);
      expect(lineFor(code), code).toContain(`code ${code}`);
    }
    expect(lineFor('key-exhausted')).toContain('réinitialisez la synchronisation');
    expect(lineFor('not-bound')).toContain('Dossier de synchro à choisir de nouveau');
    // Passagère : le nouvel essai est réel.
    expect(lineFor('state-mismatch')).toBe(GENERIC);
  });

  it('planificateur : erreur permanente, aucun cycle des 5 minutes ; passagère, cycles maintenus', async () => {
    const clock = createManualClock(NOW);
    const reasons: SyncReason[] = [];
    let status: Partial<SyncStatus> = { phase: 'error', errorCode: 'io' };
    const doc = { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
    const scheduler = startSyncScheduler({ syncNow: async (r) => void reasons.push(r), status: () => ({ ...INITIAL_STATUS, ...status }) }, { document: doc, clock, setInterval: () => 0, clearInterval: () => undefined });
    clock.advance(10 * 60_000);
    await scheduler.tick();
    expect(reasons).toEqual(['open']);
    status = { phase: 'error', errorCode: 'cloud-error' };
    await scheduler.tick();
    expect(reasons).toEqual(['open', 'timer']);
    scheduler.dispose();
  });
});

describe('erreur du dossier lié relue (audit des impasses, G)', () => {
  const VAULT = 'Le Trousseau de l’iPhone est indisponible : déverrouillez l’iPhone, la synchro reprendra';
  const RETRY = 'Relire l’état du dossier de synchronisation';

  it('Trousseau indisponible, puis retour au premier plan avec la clé lisible : ligne liée ; « Réessayer » relit aussi', async () => {
    const phone = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), platform: 'ios' });
    await phone.folder.choose();
    await phone.key.create();
    await phone.bindDevice(PHONE);
    phone.testing.setVaultAvailable(false);
    const sync = createFakeSyncService({ phase: 'idle', folderLabel: 'CircleTasks', folderKind: 'icloud', lastSyncAt: '2026-10-08T07:59:00.000Z' as IsoDateTime });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync, syncPlatform: phone, platform: { runtime: 'tauri', os: 'ios' } });
    renderIn(container, <SyncSettingsSection />);
    expect(await screen.findByText(VAULT)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: RETRY })).toBeInTheDocument();
    phone.testing.setVaultAvailable(true);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByRole('button', { name: 'Détails' })).toBeInTheDocument();
    expect(screen.queryByText(VAULT)).toBeNull();

    // « Réessayer » : même relecture, et un cycle demandé.
    phone.testing.setVaultAvailable(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const retry = await screen.findByRole('button', { name: RETRY });
    phone.testing.setVaultAvailable(true);
    act(() => {
      retry.click();
    });
    expect(await screen.findByRole('button', { name: 'Détails' })).toBeInTheDocument();
    expect(sync.calls).toContain('manual');
  });

  it('dossier inutilisable : le texte demande un autre dossier, « Choisir le dossier » proposé à côté de « Oublier »', async () => {
    const platform = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud') });
    await platform.folder.choose();
    const failing: SyncPlatform = { ...platform, folder: { ...platform.folder, info: () => Promise.reject(new SyncPlatformError('unsafe-folder')) } };
    const sync = createFakeSyncService({ phase: 'idle' });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: PHONE }), data: db.data, sync, syncPlatform: failing });
    renderIn(container, <SyncSettingsSection />);
    expect(await screen.findByText('Ce dossier ne peut pas servir à la synchronisation : choisissez-en un autre')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choisir le dossier de synchronisation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Oublier le dossier de synchronisation' })).toBeInTheDocument();
  });
});
