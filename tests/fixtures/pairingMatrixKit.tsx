import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { createHlcClock } from '../../src/domain/hlc';
import type { IsoDateTime } from '../../src/domain/types';
import type { DataAccess } from '../../src/db/repositories';
import { openTestDb, type TestDb } from '../../src/db/repositories/sql/testSetup';
import { AppContainerProvider } from '../../src/features/app/AppContainerContext';
import { useAppStatusStore } from '../../src/features/app/appStatus';
import { createAppContainer, type AppContainer } from '../../src/features/app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../../src/features/app/navigation';
import { startSyncIntegration, type SyncIntegration } from '../../src/features/sync/startSync';
import { SyncDetailsScreen } from '../../src/features/sync/SyncDetailsScreen';
import { SyncSettingsSection } from '../../src/features/sync/SyncSettingsSection';
import { createFakeSyncService, type FakeSyncService } from '../../src/features/sync/testKit';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform, type SyncPlatform } from '../../src/platform/sync';
import type { SyncStatus } from '../../src/platform/sync/types';
import { createSyncService, silentSyncLogger } from '../../src/sync';
import { PAIRING_PHONE_ID as SELF, publishedPcFolder, type PcWorld } from './pairingWorld';
import { settle } from '../setup/settle';

/**
 * Banc de la matrice « état × plateforme × écran » de l'association (Y-IOS-02, QA du parcours, demande d'Ali 0.2.2) : moteur et plateforme
 * mémoire réels quand l'état se produit par un vrai cycle, faux service pour les phases qui demandent un second appareil actif
 * (réinitialisation, oubli). Utilisé par `pairingMatrix.test.tsx` (états justes) et `pairingDefects.test.tsx` (défauts constatés).
 */

export const NOW = '2026-10-09T08:00:00.000Z';
export const IPHONE_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
export const WINDOWS_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export type Os = 'ios' | 'windows';

/** Actions de l'association et de la synchro, par leur libellé accessible (un libellé = une action pour l'utilisateur). */
export const ACTIONS = {
  choose: 'Choisir le dossier de synchronisation',
  forgetFolder: 'Oublier le dossier de synchronisation',
  rereadFolder: 'Relire l’état du dossier de synchronisation',
  details: 'Détails',
  syncNow: 'Synchroniser',
  associatePhone: 'Associer cet iPhone au PC : scanner le code d’association',
  associatePc: 'Associer cet appareil avec la clé de secours',
  showQr: 'Associer l’iPhone : afficher le code d’association',
  startNew: 'Commencer une nouvelle synchronisation sur cet iPhone',
  reset: 'Réinitialiser la synchronisation avec une nouvelle clé',
  rejoin: 'Associer de nouveau cet appareil',
  retryJoin: 'Réessayer la réception des données',
} as const;
export type Action = keyof typeof ACTIONS;

export function visibleActions(): Action[] {
  return (Object.keys(ACTIONS) as Action[]).filter((key) => screen.queryAllByRole('button', { name: ACTIONS[key] }).length > 0).sort();
}

export const BANNER_NEEDS = (os: Os): string => (os === 'ios' ? 'Associez cet iPhone au PC pour synchroniser' : 'Associez cet appareil pour synchroniser');
export const BANNER_MISMATCH = 'Ce dossier a été chiffré avec une autre clé : associez cet appareil';

// --- banc ------------------------------------------------------------------------------------------------------------------------------

export interface Rig {
  readonly db: TestDb;
  readonly world: PcWorld;
}

let rig: Rig | null = null;

export function current(): Rig {
  if (!rig) throw new Error('openRig() d’abord');
  return rig;
}

export async function openRig(): Promise<Rig> {
  const db = await openTestDb(SELF, NOW);
  rig = { db, world: await publishedPcFolder(() => db.clock.nowMs()) };
  return rig;
}

export async function closeRig(): Promise<void> {
  cleanup();
  vi.restoreAllMocks();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  const open = rig;
  rig = null;
  await open?.db.close();
}

export interface Harness {
  readonly container: AppContainer;
  readonly platform: SyncPlatform;
  readonly os: Os;
  readonly integration: SyncIntegration;
  readonly fake: FakeSyncService | null;
  readonly fakeStatus: Partial<SyncStatus> | null;
}

function containerFor(platform: SyncPlatform, os: Os, service: FakeSyncService | null, data?: DataAccess): AppContainer {
  const { db } = current();
  const access = data ?? db.data;
  const hlc = createHlcClock({ clock: db.clock, deviceId: SELF });
  const sync =
    service ??
    createSyncService({ data: access, platform, hlc, clock: db.clock, deviceId: SELF, devicePlatform: os, sv: 14, appVersion: '0.2.3', logger: silentSyncLogger, setTimeout: () => 0, clearTimeout: () => undefined });
  return createAppContainer({ clock: db.clock, hlc, data: access, sync, syncPlatform: platform, platform: { runtime: 'tauri', os } });
}

const noTimers = { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined };

export interface HarnessOptions {
  /** État du faux service (phases qui demandent un second appareil) ; absent : moteur réel. */
  readonly fake?: Partial<SyncStatus>;
  /** Cycles manuels lancés après celui de l'ouverture (moteur réel). */
  readonly cycles?: number;
  /** Aucun cycle du tout (état d'une app qui vient de démarrer). */
  readonly noCycle?: boolean;
  /** Accès aux données de l’app (base occupée…) ; par défaut la base de test. */
  readonly data?: DataAccess;
  /** Le planificateur écoute le vrai `document` (retour au premier plan par `visibilitychange`). */
  readonly realDocument?: boolean;
}

/** Démarre l'app sur `platform` : intégration de la synchro (planificateur, bandeaux) et cycles demandés. */
export async function harness(platform: SyncPlatform, os: Os, options: HarnessOptions = {}): Promise<Harness> {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(os === 'ios' ? IPHONE_AGENT : WINDOWS_AGENT);
  const fake = options.fake ? createFakeSyncService({ folderLabel: 'CircleTasks', folderKind: 'icloud', lastSyncAt: '2026-10-09T07:55:00.000Z' as IsoDateTime, ...options.fake }) : null;
  const container = containerFor(platform, os, fake, options.data);
  const integration = startSyncIntegration(container, { document: options.realDocument ? document : fakeDocument(), ...noTimers });
  if (!fake && options.noCycle !== true) {
    for (let i = 0; i < (options.cycles ?? 1); i += 1) {
      await act(async () => {
        await container.sync?.syncNow(i === 0 ? 'open' : 'manual');
      });
    }
  }
  await act(async () => {
    await integration.refreshed();
  });
  return { container, platform, os, integration, fake, fakeStatus: options.fake ?? null };
}

function fakeDocument(): Document {
  return { visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as Document;
}

/** Relance de l'app : nouveau conteneur et nouveau service sur la même base et la même plateforme (coffre, dossier), sans cycle. */
export async function restart(h: Harness, options: HarnessOptions = {}): Promise<Harness> {
  h.integration.dispose();
  useAppStatusStore.setState({ sources: {} });
  cleanup();
  return harness(h.platform, h.os, { ...(h.fakeStatus ? { fake: h.fakeStatus } : {}), ...options });
}

/** Passage en arrière-plan puis retour au premier plan (les écrans relisent, le planificateur lance un cycle d’ouverture). */
export async function backgroundThenForeground(h: Harness): Promise<void> {
  const setState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  await act(async () => {
    setState('hidden');
    setState('visible');
    await h.integration.refreshed();
  });
}

export const renderIn = (container: AppContainer, node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);

export interface Seen {
  readonly settings: Action[];
  readonly details: Action[];
  readonly banner: string | null;
}

/** Texte du bandeau A-09 posé par la synchro (le plus urgent) ; « attente d'iCloud » nommée si elle seule est posée. */
export function bannerText(): string | null {
  const sources = useAppStatusStore.getState().sources;
  if (sources.syncTrouble) return sources.syncTrouble.message ?? sources.syncTrouble.detail ?? null;
  if (sources.waitingIcloud) return sources.waitingIcloud.message ?? '(attente d’iCloud)';
  if (sources.updateRequired) return '(mise à jour requise)';
  return null;
}

/** Actions offertes par Réglages › Synchronisation, par Détails, et bandeau. */
export async function observe(h: Harness): Promise<Seen> {
  const { db } = current();
  renderIn(h.container, <SyncSettingsSection />);
  await settle(db.driver);
  const settings = visibleActions();
  cleanup();
  renderIn(h.container, <SyncDetailsScreen />);
  await settle(db.driver);
  const details = visibleActions();
  cleanup();
  return { settings, details, banner: bannerText() };
}

// --- états -----------------------------------------------------------------------------------------------------------------------------

/** Import d'une clé : fenêtre `pairing` ouverte d'abord sur PC, depuis la fenêtre principale sur iPhone. */
export async function associate(platform: MemorySyncPlatform, os: Os, qrText: string): Promise<void> {
  if (os === 'windows') await platform.key.openPairing('import');
  await platform.key.import({ qrText });
}

/** Dossier du PC choisi, pas de clé. */
export async function dataNoKey(os: Os, options: HarnessOptions = {}): Promise<Harness> {
  return harness(await current().world.device(os, SELF, true), os, options);
}

/** Dossier du PC choisi, clé du PC reçue. */
export async function keyEqual(os: Os, options: HarnessOptions = {}): Promise<Harness> {
  const platform = await current().world.device(os, SELF, true);
  await associate(platform, os, await current().world.qr());
  return harness(platform, os, options);
}

/** Trousseau gardé d'une installation précédente : clé créée sur un autre dossier, puis le dossier du PC choisi. */
export async function keyMismatch(os: Os, options: HarnessOptions = {}): Promise<Harness> {
  const { world } = current();
  const platform = await world.device(os, SELF, false);
  platform.testing.setChooser(new MemorySyncFolder('icloud'));
  await platform.folder.choose();
  await platform.key.create();
  platform.testing.setChooser(world.folder);
  await platform.folder.choose();
  await platform.bindDevice(SELF);
  return harness(platform, os, options);
}

/** Dossier vide, choisi par le bouton « Choisir le dossier » de Réglages (PC : clé créée ; iPhone : jamais de clé créée). */
export async function chooseEmptyFolder(os: Os): Promise<Harness> {
  const { db } = current();
  const platform = createMemorySyncPlatform({ folder: new MemorySyncFolder('icloud'), platform: os, nowMs: () => db.clock.nowMs() });
  const h = await harness(platform, os, { noCycle: true });
  renderIn(h.container, <SyncSettingsSection />);
  fireEvent.click(await screen.findByRole('button', { name: ACTIONS.choose }));
  await settle(db.driver);
  cleanup();
  await act(async () => {
    await h.container.sync?.syncNow('manual');
  });
  return h;
}

/** Faux service d'un état qui demande un autre appareil actif ; clé réellement présente et égale sur cet appareil. */
export async function fakePhase(os: Os, status: Partial<SyncStatus>): Promise<Harness> {
  const platform = await current().world.device(os, SELF, true);
  await associate(platform, os, await current().world.qr());
  return harness(platform, os, { fake: status });
}
