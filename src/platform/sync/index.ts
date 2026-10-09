import type { OsFamily, Runtime } from '../runtime';
import { createMemorySyncPlatform } from './memory';
import { loadBarcodeScanner } from './barcodeScanner';
import { createTauriSync } from './tauriSync';
import { SyncPlatformError, type SyncErrorCode, type SyncPlatform } from './types';

export * from './types';
export { MemorySyncFolder, createMemorySyncPlatform, type MemorySyncOptions, type MemorySyncPlatform, type MemorySyncTesting, type StateFileCopy } from './memory';
export { createTauriSync, loadTauriSyncInvoker, toSyncError, type QrScanner, type SyncInvoker, type TauriSyncOptions } from './tauriSync';
export { loadBarcodeScanner } from './barcodeScanner';

/**
 * Plateforme de synchronisation courante (ADR 0011, section 11 ; Y-01 critère 18, Y-IOS-01 critère 8) : app installée (PC et iPhone) ->
 * commandes Rust (`tauriSync`) ; navigateur de développement, Vitest et Playwright -> implémentation mémoire. En
 * développement, un test de bout en bout peut poser `globalThis.__ctSync` (faux) avant le chargement de la page, ou annoncer le
 * simulateur de dossier (`globalThis.__ctSyncSim`, Y-04 : parcours 10 à deux pages) : `__ctSync` est alors installé ici, **seulement si
 * `import.meta.env.DEV`** (un build ne contient ni le client ni l'affectation).
 */
export function openSyncPlatform(runtime: Runtime, os: OsFamily): SyncPlatform {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctSync?: SyncPlatform; __ctSyncSim?: SyncSimConfig };
    if (!scope.__ctSync && scope.__ctSyncSim) scope.__ctSync = createSyncSimClient(scope.__ctSyncSim);
    const override = scope.__ctSync;
    if (override) return override;
  }
  // Plateforme mémoire : navigateur de développement et tests seulement (`import.meta.env.DEV`). Le build livré ne la contient pas (hors
  // du JavaScript de départ, budget 350 Ko) ; un navigateur sans l'app installée reçoit une synchro indisponible (`available()` faux).
  if (runtime === 'web') return import.meta.env.DEV ? createMemorySyncPlatform() : createTauriSync({ available: false });
  // ADR 0011 §22 point 7 (Y-IOS-01) : l'iPhone a ses commandes `sync_*` (capability `sync-ios.json`, plugin folder-bookmark).
  return createTauriSync({ available: os === 'windows' || os === 'ios', ...(os === 'ios' ? { scanner: loadBarcodeScanner() } : {}) });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Client du simulateur de dossier (Y-04, développement seulement ; serveur : tests/sim/syncFolderSim.ts)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Annonce du simulateur posée par Playwright avant le chargement de la page. */
interface SyncSimConfig {
  /** URL du simulateur (port fixe de `tests/sim/ports.ts`). */
  readonly url: string;
  /** Espace de test propre au test (deux workers ne partagent jamais un état). */
  readonly room: string;
  /** Nom de l'appareil dans l'espace (« pc », « iphone »). */
  readonly device: string;
  /** Premier appareil (dossier et clé créés) ou appareil associé au premier (clé de secours importée par le simulateur). */
  readonly role: 'first' | 'join';
  /** Plateforme de l'appareil (celle que publie l'app : agent du navigateur), tenue par le simulateur comme par Rust. */
  readonly platform: 'windows' | 'ios';
}

/** JSON qui garde les `Map` (accusés de `PublishedDeviceState`) ; même codage que le simulateur. */
const MAP_TAG = '__ctMap';
const encodeSim = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (v instanceof Map ? { [MAP_TAG]: [...(v as Map<unknown, unknown>)] } : v));
const decodeSim = (text: string): unknown =>
  JSON.parse(text, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && Array.isArray((v as Record<string, unknown>)[MAP_TAG]) ? new Map((v as Record<string, [unknown, unknown][]>)[MAP_TAG]) : v));

/**
 * `SyncPlatform` adossée au simulateur : chaque appel part au simulateur, qui tient le rôle de Rust (plateforme mémoire de l'appareil,
 * son dossier, son coffre) ; « iCloud » recopie les dossiers sur ordre du test. Les codes d'erreur reviennent en `SyncPlatformError`.
 */
function createSyncSimClient(config: SyncSimConfig): SyncPlatform {
  const call = async (path: string, args: readonly unknown[]): Promise<never> => {
    const response = await fetch(`${config.url}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: encodeSim({ room: config.room, device: config.device, role: config.role, platform: config.platform, path, args }) });
    const reply = decodeSim(await response.text()) as { readonly ok?: unknown; readonly error?: { readonly code?: SyncErrorCode; readonly message?: string } };
    if (reply.error) throw reply.error.code ? new SyncPlatformError(reply.error.code) : new Error(reply.error.message ?? 'simulateur');
    return reply.ok as never;
  };
  const method =
    (path: string) =>
    (...args: unknown[]): Promise<never> =>
      call(path, args);
  return {
    available: () => true,
    folder: { info: method('folder.info'), choose: method('folder.choose'), forget: method('folder.forget') },
    key: {
      status: method('key.status'),
      create: method('key.create'),
      openPairing: method('key.openPairing'),
      pairingPayload: method('key.pairingPayload'),
      closePairing: method('key.closePairing'),
      import: method('key.import'),
      ...(config.platform === 'ios'
        ? { scanAndImport: method('key.scanAndImport'), cancelScan: method('key.cancelScan'), cameraPermission: method('key.cameraPermission'), openCameraSettings: method('key.openCameraSettings') }
        : {}),
    },
    bindDevice: method('bindDevice'),
    scan: method('scan'),
    readJournal: method('readJournal'),
    appendJournal: method('appendJournal'),
    writeState: method('writeState'),
    async writeSnapshot(r) {
      const pages: (readonly string[])[] = [];
      for await (const page of r.records) pages.push(page);
      return call('writeSnapshot', [{ ...r, records: pages }]);
    },
    readSnapshot: method('readSnapshot'),
    deleteOwn: method('deleteOwn'),
    abandonOrphanEpoch: method('abandonOrphanEpoch'),
    restoreMarker: { get: method('restoreMarker.get'), clear: method('restoreMarker.clear') },
    forget: { device: method('forget.device'), deleteFiles: method('forget.deleteFiles') },
    reset: { start: method('reset.start') },
  };
}
