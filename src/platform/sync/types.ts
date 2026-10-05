/**
 * Contrat de la synchronisation par iCloud Drive (ADR 0011, section 11 ; Y-01 à Y-09).
 *
 * `SyncPlatform` est la seule porte vers les 21 commandes Rust `sync_*` (dossier, clé, appairage, fichiers chiffrés, marqueur de
 * restauration) : du texte clair JSON circule, jamais un chemin ; la clé seulement aux deux points de la section 2.1. `SyncService`
 * est le service exposé par le conteneur (`AppContainer.sync`), implémenté par `src/sync` (lot Y2).
 *
 * Couche platform : n'importe que `src/domain`.
 */

import type { DeviceId, Hlc, IsoDateTime } from '../../domain/types';
import {
  isSyncErrorCode,
  type EpochId,
  type PublishedDeviceState,
  type PublishedDeviceStateJson,
  type RecordCursor,
  type SyncDevicePlatform,
  type SyncErrorCode,
} from '../../domain/sync/format';

export { SYNC_ERROR_CODES, isSyncErrorCode, type SyncErrorCode } from '../../domain/sync/format';

// ---------------------------------------------------------------------------------------------------------------------------------
// Erreurs
// ---------------------------------------------------------------------------------------------------------------------------------

/** Rejet d'une commande `sync_*` : `{ code, message }`. Le message ne recopie jamais l'entrée (ni chemin, ni clé, section 2.1). */
export class SyncPlatformError extends Error {
  override readonly name = 'SyncPlatformError';
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, options: { cause?: unknown } = {}) {
    super(`synchro : ${code}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}

/** Code d'une erreur de synchro, reconnue par sa forme (les faux des tests ont leur propre classe) ; `io` par défaut. */
export function syncErrorCodeOf(error: unknown): SyncErrorCode {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return isSyncErrorCode(code) ? code : 'io';
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Types échangés
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SyncFolderInfo {
  readonly configured: boolean;
  /** Libellé seulement (« iCloud Drive / CircleTasks »), jamais un chemin. */
  readonly label: string | null;
  readonly kind: 'icloud' | 'local' | 'unknown';
  readonly pinned: boolean;
}

export type FileAvailability = 'local' | 'cloud' | 'error';

export type DeviceStateStatus = 'ok' | 'missing' | 'cloud-pending' | 'foreign' | 'corrupt' | 'rollback' | 'too-large' | 'newer-format';

export interface EpochListing {
  readonly epoch: EpochId;
  readonly segments: readonly number[];
  readonly snapshots: readonly number[];
}

export interface DeviceScan {
  readonly deviceId: DeviceId;
  readonly kid: string | null;
  readonly state: PublishedDeviceState | null;
  readonly stateStatus: DeviceStateStatus;
  readonly epochs: readonly EpochListing[];
  /** Fichiers attendus et pas encore lisibles (noms stricts seulement). */
  readonly pending: readonly { readonly file: string; readonly availability: FileAvailability }[];
}

export interface FolderScan {
  readonly devices: readonly DeviceScan[];
  /** Entrées ignorées (noms non stricts, copies de conflit, `*.tmp`, dossiers en surnombre). */
  readonly ignored: number;
  readonly totalBytes: number;
  readonly tooManyDevices: boolean;
}

/** Page de texte clair : jamais au-delà de la tête authentifiée. `next` = position après le dernier enregistrement rendu. */
export interface ReadPage {
  readonly records: readonly string[];
  readonly next: RecordCursor;
  readonly status: 'complete' | 'more' | 'cloud-pending' | 'truncated';
}

export interface RestoreMarker {
  readonly backup: string;
  readonly backupTakenAt: IsoDateTime;
  readonly restoredAt: IsoDateTime;
  readonly schemaVersion: number;
}

export type PairingMode = 'show' | 'import';

export interface PairingPayload {
  readonly qrText: string;
  readonly recoveryKey: string;
  /** Expiration (ms depuis l'époque Unix). */
  readonly expiresAt: number;
}

export type KeyImportInput = { readonly qrText: string } | { readonly recoveryKey: string } | { readonly scan: true };

export interface KeyImportResult {
  readonly kid: string;
  readonly pairedBy: DeviceId | null;
  readonly epoch: EpochId | null;
}

export interface AppendJournalRequest {
  readonly epoch: EpochId;
  readonly segment: number;
  /** Nombre d'enregistrements que le moteur attend dans le segment (`segment-mismatch` sinon). */
  readonly expectRecords: number;
  readonly sv: number;
  /** Plus grand hlc des enregistrements ajoutés ; strictement supérieur au maximum cumulé de l'époque (`hlc-order`). */
  readonly maxHlc: Hlc;
  readonly records: readonly string[];
}

export interface AppendJournalResult {
  /** Index du premier enregistrement ajouté, calculé par Rust. */
  readonly firstRecord: number;
  readonly head: RecordCursor;
}

export interface ReadJournalRequest {
  readonly deviceId: DeviceId;
  readonly epoch: EpochId;
  readonly from: RecordCursor;
  readonly maxBytes?: number;
}

export interface ReadSnapshotRequest {
  readonly deviceId: DeviceId;
  readonly epoch: EpochId;
  readonly seq: number;
  readonly fromRecord: number;
  readonly maxBytes?: number;
}

export interface OwnFileRef {
  readonly epoch: EpochId;
  readonly kind: 'j' | 's' | 'epoch';
  /** Numéro du segment ou de l'instantané ; absent pour `epoch` (dossier d'époque entier). */
  readonly n?: number;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Commandes Tauri (section 11.1)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Forme IPC d'un appareil listé : l'état est en JSON (accusés en objet), analysé strictement côté TypeScript (`parse.ts`). */
export interface DeviceScanJson extends Omit<DeviceScan, 'state'> {
  readonly state: PublishedDeviceStateJson | null;
}

export interface FolderScanJson extends Omit<FolderScan, 'devices'> {
  readonly devices: readonly DeviceScanJson[];
}

/** Entrée (arguments d'`invoke`) et sortie de chaque commande `sync_*`. */
export interface SyncCommandMap {
  sync_folder_info: { readonly args: void; readonly result: SyncFolderInfo };
  sync_folder_choose: { readonly args: void; readonly result: SyncFolderInfo | null };
  sync_folder_forget: { readonly args: { readonly eraseKey: boolean }; readonly result: null };
  sync_bind_device: { readonly args: { readonly deviceId: DeviceId }; readonly result: null };
  sync_key_status: { readonly args: void; readonly result: { readonly present: boolean; readonly kid: string | null } };
  sync_key_create: { readonly args: void; readonly result: { readonly kid: string } };
  sync_pairing_open: { readonly args: { readonly mode: PairingMode }; readonly result: null };
  sync_pairing_payload: { readonly args: { readonly renew?: true }; readonly result: PairingPayload };
  sync_key_import: { readonly args: KeyImportInput; readonly result: KeyImportResult };
  sync_pairing_close: { readonly args: void; readonly result: null };
  sync_scan: { readonly args: void; readonly result: FolderScanJson };
  sync_read_journal: { readonly args: ReadJournalRequest; readonly result: ReadPage };
  sync_append_journal: { readonly args: AppendJournalRequest; readonly result: AppendJournalResult };
  sync_write_state: { readonly args: { readonly sv: number; readonly state: PublishedDeviceStateJson }; readonly result: null };
  sync_snapshot_begin: {
    readonly args: { readonly epoch: EpochId; readonly seq: number; readonly sv: number };
    readonly result: { readonly handle: number };
  };
  sync_snapshot_append: { readonly args: { readonly handle: number; readonly records: readonly string[] }; readonly result: null };
  sync_snapshot_commit: { readonly args: { readonly handle: number }; readonly result: null };
  sync_read_snapshot: { readonly args: ReadSnapshotRequest; readonly result: ReadPage };
  sync_delete_own: { readonly args: { readonly files: readonly OwnFileRef[] }; readonly result: { readonly deleted: number } };
  sync_restore_marker_get: { readonly args: void; readonly result: RestoreMarker | null };
  sync_restore_marker_clear: { readonly args: void; readonly result: null };
}

export type SyncCommand = keyof SyncCommandMap;

/** Fenêtre à laquelle chaque commande est accordée sur PC (capabilities `sync.json` et `sync-pairing.json`). */
export const SYNC_COMMAND_WINDOWS: { readonly [C in SyncCommand]: 'main' | 'pairing' } = {
  sync_folder_info: 'main',
  sync_folder_choose: 'main',
  sync_folder_forget: 'main',
  sync_bind_device: 'main',
  sync_key_status: 'main',
  sync_key_create: 'main',
  sync_pairing_open: 'main',
  sync_pairing_payload: 'pairing',
  sync_key_import: 'pairing',
  sync_pairing_close: 'pairing',
  sync_scan: 'main',
  sync_read_journal: 'main',
  sync_append_journal: 'main',
  sync_write_state: 'main',
  sync_snapshot_begin: 'main',
  sync_snapshot_append: 'main',
  sync_snapshot_commit: 'main',
  sync_read_snapshot: 'main',
  sync_delete_own: 'main',
  sync_restore_marker_get: 'main',
  sync_restore_marker_clear: 'main',
};

/** Les 21 commandes, dans l'ordre de la section 11.1 (même liste que `AppManifest::commands` de `build.rs`, lot Y1). */
export const SYNC_COMMANDS = Object.keys(SYNC_COMMAND_WINDOWS) as readonly SyncCommand[];

// ---------------------------------------------------------------------------------------------------------------------------------
// Contrat de la plateforme
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SyncPlatform {
  /** Faux sur iOS jusqu'à l'ordre 5. */
  available(): boolean;
  readonly folder: {
    info(): Promise<SyncFolderInfo>;
    /** null si l'utilisateur annule. */
    choose(): Promise<SyncFolderInfo | null>;
    forget(o: { readonly eraseKey: boolean }): Promise<void>;
  };
  readonly key: {
    status(): Promise<{ readonly present: boolean; readonly kid: string | null }>;
    create(): Promise<{ readonly kid: string }>;
    /** Fenêtre main : confirmation native puis fenêtre dédiée `pairing` (section 2.1). */
    openPairing(mode: PairingMode): Promise<void>;
    /** Fenêtre `pairing` seulement (PC), instance `show`. Contient la clé : état local du composant, jamais Zustand ni journal. */
    pairingPayload(o?: { readonly renew: true }): Promise<PairingPayload>;
    /** Fenêtre `pairing` seulement : détruit la fenêtre appelante. */
    closePairing(): Promise<void>;
    /** PC : fenêtre `pairing` (instance `import`) ; iPhone : main. Entrée sensible : transmise telle quelle, jamais stockée. */
    import(input: KeyImportInput): Promise<KeyImportResult>;
  };
  /** Figé : un autre identifiant est refusé (`already-bound`) tant que le dossier n'est pas oublié. */
  bindDevice(deviceId: DeviceId): Promise<void>;
  scan(): Promise<FolderScan>;
  readJournal(r: ReadJournalRequest): Promise<ReadPage>;
  /** 1 Mio au plus par appel ; `segment-full` : segment suivant ; `hlc-order` si `maxHlc` ne dépasse pas le maximum de l'époque. */
  appendJournal(r: AppendJournalRequest): Promise<AppendJournalResult>;
  writeState(r: { readonly sv: number; readonly state: PublishedDeviceState }): Promise<void>;
  /** Écriture par pages (`sync_snapshot_begin` / `append` / `commit`) ; visible seulement après le dernier appel. */
  writeSnapshot(r: {
    readonly epoch: EpochId;
    readonly seq: number;
    readonly sv: number;
    readonly records: AsyncIterable<readonly string[]>;
  }): Promise<void>;
  readSnapshot(r: ReadSnapshotRequest): Promise<ReadPage>;
  /** Supprime ses propres fichiers ; renvoie le nombre supprimé (`current-epoch` pour le dossier de l'époque courante). */
  deleteOwn(files: readonly OwnFileRef[]): Promise<number>;
  readonly restoreMarker: { get(): Promise<RestoreMarker | null>; clear(): Promise<void> };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Service exposé par le conteneur (implémenté par src/sync, lot Y2)
// ---------------------------------------------------------------------------------------------------------------------------------

export type SyncPhase =
  | 'not-configured'
  | 'needs-pairing'
  | 'idle'
  | 'syncing'
  | 'waiting-icloud'
  | 'restore-choice'
  | 'update-required'
  | 'clock-ahead'
  | 'key-mismatch'
  | 'error';

export type DeviceSyncStatus = 'active' | 'expired' | 'newer-major' | 'clock-ahead' | 'corrupt' | 'foreign' | 'rollback' | 'forgotten';

export interface SyncDeviceStatus {
  readonly deviceId: DeviceId;
  readonly platform: SyncDevicePlatform;
  readonly self: boolean;
  readonly lastReadAt: IsoDateTime | null;
  readonly status: DeviceSyncStatus;
}

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly lastSyncAt: IsoDateTime | null;
  readonly folderLabel: string | null;
  readonly devices: readonly SyncDeviceStatus[];
  readonly pendingFiles: readonly string[];
  readonly conflictsThisWeek: number;
  /** Nouvel appareil (Y-06) : enregistrements lus / total. */
  readonly progress: { readonly done: number; readonly total: number } | null;
}

export type SyncReason = 'open' | 'timer' | 'hide' | 'quit' | 'manual' | 'tray';

export interface RemoteChanges {
  readonly tables: ReadonlySet<string>;
  readonly ids: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface SyncService {
  status(): SyncStatus;
  /** Pour `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Ne rejette jamais. */
  syncNow(reason: SyncReason): Promise<void>;
  onRemoteChanges(listener: (c: RemoteChanges) => void): () => void;
  chooseRestoreOption(option: 'apply-everywhere' | 'keep-synced'): Promise<void>;
}
