import type { DeviceId } from '../../domain/types';
import { publishedStateFromJson, publishedStateToJson } from '../../domain/sync/format';
import {
  SyncPlatformError,
  syncErrorCodeOf,
  type AppendJournalResult,
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
  /** Faux sur iOS jusqu'à l'ordre 5 (les commandes ne sont accordées qu'au PC). */
  readonly available: boolean;
  readonly invoke?: SyncInvoker;
}

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
    },
    bindDevice: async (deviceId: DeviceId) => {
      await call('sync_bind_device', { deviceId });
    },
    scan: async (r): Promise<FolderScan> => {
      const raw = await call('sync_scan', { keep: r.keep });
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
  };
}
