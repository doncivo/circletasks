import type { DeviceId } from '../../domain/types';
import { publishedStateFromJson, publishedStateToJson } from '../../domain/sync/format';
import {
  SyncPlatformError,
  syncErrorCodeOf,
  type AppendJournalResult,
  type CameraPermission,
  type ScanImportOutcome,
  type DeviceScan,
  type FolderScan,
  type FolderScanJson,
  type KeyImportResult,
  type PairingPayload,
  type ReadPage,
  type RestoreMarker,
  type SyncCommand,
  type SyncCommandMap,
  type SyncFolderInfo,
  type SyncFolderInfoJson,
  type SyncPlatform,
} from './types';

/**
 * Implémentation Tauri de `SyncPlatform` (ADR 0011, section 11 ; Y-01 critère 18) : **seul** code qui appelle les commandes Rust
 * `sync_*` (contrôlé par un test qui cherche `invoke('sync_` dans `src/`). Aucune donnée n'est gardée ici : ni chemin (Rust ne rend
 * qu'un libellé), ni clé, ni texte du QR, ni saisie. Les rejets Rust `{ code, message }` deviennent des `SyncPlatformError { code }`
 * sans recopie du message ni de l'entrée.
 */

/** Appel d'une commande `sync_*` (injectable pour les tests). */
export type SyncInvoker = <C extends SyncCommand>(command: C, args?: SyncCommandMap[C]['args']) => Promise<SyncCommandMap[C]['result']>;

/** `invoke` de Tauri, chargé à la demande (absent du navigateur de développement). */
export function loadTauriSyncInvoker(): SyncInvoker {
  return async (command, args) => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(command, (args ?? {}) as Record<string, unknown>);
  };
}

export interface TauriSyncOptions {
  /** Vrai sur PC et sur iPhone (capabilities `sync.json` et `sync-ios.json`). */
  readonly available: boolean;
  readonly invoke?: SyncInvoker;
  /**
   * iPhone (ADR 0011 §23 point 2) : plugin barcode-scanner chargé à la demande ; absent (PC) : aucune méthode de scan. Injectable (tests).
   */
  readonly scanner?: () => Promise<QrScanner>;
  /** Document observé (premier plan, masquage pendant le scan) ; tests : injecté. */
  readonly document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

/** API du plugin barcode-scanner utilisée (JS seulement : aucune API Rust publique, ADR 0011 §23 point 2). */
export interface QrScanner {
  checkPermissions(): Promise<string>;
  requestPermissions(): Promise<string>;
  scan(options: { readonly windowed: true; readonly formats: readonly string[] }): Promise<{ readonly content: string }>;
  cancel(): Promise<void>;
  openAppSettings(): Promise<void>;
  /** `Format.QRCode`. */
  readonly qrFormat: string;
}

/** `prompt-with-rationale` (Android) et toute valeur inconnue : à demander. */
const cameraState = (raw: string): CameraPermission => (raw === 'granted' ? 'granted' : raw === 'denied' ? 'denied' : 'prompt');

/** Rejet Rust -> `SyncPlatformError` (code seul ; `io` pour une erreur inconnue). */
export function toSyncError(error: unknown): SyncPlatformError {
  return new SyncPlatformError(syncErrorCodeOf(error));
}

/** Forme IPC du dossier -> `SyncFolderInfo` (nom du dossier dans `label`). */
function folderFromJson(info: SyncFolderInfoJson): SyncFolderInfo {
  return { configured: info.configured, label: info.name, kind: info.kind, pinned: info.pinned };
}

function deviceFromJson(device: FolderScanJson['devices'][number]): DeviceScan {
  if (device.state === null) return { ...device, state: null };
  const state = publishedStateFromJson(device.state);
  // Rust a déjà analysé l'état ; un écart ici (version plus récente de Rust ?) est traité comme un état corrompu, jamais appliqué.
  return state ? { ...device, state } : { ...device, state: null, stateStatus: 'corrupt' };
}

export function createTauriSync(options: TauriSyncOptions): SyncPlatform {
  const invoke = options.invoke ?? loadTauriSyncInvoker();

  async function call<C extends SyncCommand>(command: C, args?: SyncCommandMap[C]['args']): Promise<SyncCommandMap[C]['result']> {
    try {
      return await invoke(command, args);
    } catch (error) {
      throw toSyncError(error);
    }
  }

  /** Scan en cours : annulation demandée (« Annuler », masquage de la page). */
  let scanning: { cancelled: boolean; readonly scanner: QrScanner } | null = null;

  /**
   * ADR 0011 §23 point 2 (troisième point d'exposition de la section 2.1) : le texte lu ne vit que dans la variable locale `text`, passé
   * **aussitôt** à `sync_key_import({ qrText })` puis remis à null ; il n'est jamais rendu, ni journalisé, ni recopié dans une erreur.
   */
  async function scanAndImport(load: () => Promise<QrScanner>): Promise<ScanImportOutcome> {
    const doc = options.document ?? (typeof document === 'undefined' ? null : document);
    if (!doc || doc.visibilityState === 'hidden' || scanning) return { kind: 'failed', code: 'not-foreground' };
    let scanner: QrScanner;
    try {
      scanner = await load();
      let permission = cameraState(await scanner.checkPermissions());
      if (permission === 'prompt') permission = cameraState(await scanner.requestPermissions());
      if (permission !== 'granted') return { kind: 'camera-denied' };
    } catch {
      return { kind: 'failed', code: 'io' };
    }
    const current = { cancelled: false, scanner };
    scanning = current;
    const onVisibility = (): void => {
      if (doc.visibilityState !== 'hidden') return;
      current.cancelled = true;
      void scanner.cancel().catch(() => undefined);
    };
    doc.addEventListener('visibilitychange', onVisibility);
    // Texte lu : seul porteur, vidé dès qu'il est passé à Rust (et dans tous les cas en sortie).
    const held: { text: string | null } = { text: null };
    try {
      try {
        held.text = (await scanner.scan({ windowed: true, formats: [scanner.qrFormat] })).content;
      } catch {
        return current.cancelled ? { kind: 'cancelled' } : { kind: 'failed', code: 'io' };
      }
      if (current.cancelled) return { kind: 'cancelled' };
      const request = { qrText: held.text };
      held.text = null;
      try {
        return { kind: 'imported', result: await call('sync_key_import', request) };
      } catch (error) {
        return { kind: 'failed', code: syncErrorCodeOf(error) };
      }
    } finally {
      held.text = null;
      doc.removeEventListener('visibilitychange', onVisibility);
      if (scanning === current) scanning = null;
    }
  }

  const scanner = options.scanner;
  const scanMethods = scanner
    ? {
        scanAndImport: () => scanAndImport(scanner),
        cancelScan: async (): Promise<void> => {
          const current = scanning;
          if (!current) return;
          current.cancelled = true;
          await current.scanner.cancel().catch(() => undefined);
        },
        cameraPermission: async (): Promise<CameraPermission> => {
          try {
            return cameraState(await (await scanner()).checkPermissions());
          } catch {
            return 'prompt';
          }
        },
        openCameraSettings: async (): Promise<void> => {
          await (await scanner()).openAppSettings();
        },
      }
    : {};

  return {
    available: () => options.available,
    folder: {
      info: async (): Promise<SyncFolderInfo> => folderFromJson(await call('sync_folder_info')),
      choose: async (): Promise<SyncFolderInfo | null> => {
        const info = await call('sync_folder_choose');
        return info === null ? null : folderFromJson(info);
      },
      forget: async ({ eraseKey }) => {
        await call('sync_folder_forget', { eraseKey });
      },
    },
    key: {
      status: () => call('sync_key_status'),
      create: () => call('sync_key_create'),
      openPairing: async (mode) => {
        await call('sync_pairing_open', { mode });
      },
      pairingPayload: (o): Promise<PairingPayload> => call('sync_pairing_payload', o?.renew ? { renew: true } : {}),
      closePairing: async () => {
        await call('sync_pairing_close');
      },
      import: (input): Promise<KeyImportResult> => call('sync_key_import', input),
      ...scanMethods,
    },
    bindDevice: async (deviceId: DeviceId) => {
      await call('sync_bind_device', { deviceId });
    },
    scan: async (r): Promise<FolderScan> => {
      // ADR 0011 §22 point 4 : budget d'hydratation réduit transmis seulement s'il est donné (cycle `hide` de l'iPhone).
      const raw = await call('sync_scan', r.hydrateBudgetMs === undefined ? { keep: r.keep } : { keep: r.keep, hydrateBudgetMs: r.hydrateBudgetMs });
      return { ...raw, devices: raw.devices.map(deviceFromJson) };
    },
    readJournal: (r): Promise<ReadPage> => call('sync_read_journal', r),
    appendJournal: (r): Promise<AppendJournalResult> => call('sync_append_journal', r),
    writeState: async (r) => {
      await call('sync_write_state', { sv: r.sv, state: publishedStateToJson(r.state) });
    },
    writeSnapshot: async (r) => {
      const { handle } = await call('sync_snapshot_begin', { epoch: r.epoch, seq: r.seq, sv: r.sv });
      for await (const records of r.records) await call('sync_snapshot_append', { handle, records });
      await call('sync_snapshot_commit', { handle });
    },
    readSnapshot: (r): Promise<ReadPage> => call('sync_read_snapshot', r),
    deleteOwn: async (files) => (await call('sync_delete_own', { files })).deleted,
    restoreMarker: {
      get: (): Promise<RestoreMarker | null> => call('sync_restore_marker_get'),
      clear: async () => {
        await call('sync_restore_marker_clear');
      },
    },
    forget: {
      device: async (deviceId) => {
        await call('sync_device_forget', { deviceId });
      },
      deleteFiles: (deviceId) => call('sync_forgotten_delete', { deviceId }),
    },
    reset: {
      start: () => call('sync_reset_key'),
    },
  };
}
