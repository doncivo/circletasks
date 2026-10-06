/**
 * Contrat de la synchronisation par iCloud Drive (ADR 0011, section 11 ; Y-01 à Y-09).
 *
 * `SyncPlatform` est la seule porte vers les 24 commandes Rust `sync_*` (dossier, clé, appairage, fichiers chiffrés, marqueur de
 * restauration ; oubli d'un appareil et réinitialisation, lot Y4) : du texte clair JSON circule, jamais un chemin ; la clé seulement aux deux points de la section 2.1. `SyncService`
 * est le service exposé par le conteneur (`AppContainer.sync`), implémenté par `src/sync` (lot Y2).
 *
 * Couche platform : n'importe que `src/domain`.
 */

import type { ReintegrationFailure } from '../../domain/sync/compat';
import type { DeviceId, Hlc, IsoDateTime } from '../../domain/types';
import type { RestoreOption } from '../../domain/sync/epoch';
import type { SyncPhase as DomainSyncPhase, SyncWarningCode } from '../../domain/syncBanners';
import {
  isSyncErrorCode,
  type EpochId,
  type ForgottenDevice,
  type PublishedDeviceState,
  type PublishedDeviceStateJson,
  type RecordCursor,
  type ResetNotice,
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
  /**
   * Nom du dossier (« CircleTasks »), jamais un chemin. Le libellé affiché (« iCloud Drive / CircleTasks ») est composé par l'interface
   * avec `kind` et les textes de `src/i18n` (revue 13 du lot Y1).
   */
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
  /**
   * Un dossier listait plus de 10 000 entrées : les entrées en surnombre sont ignorées (section 1.6, « scan signalé incomplet »).
   * Champ absent de la section 11.2 : ajouté pour porter ce signal (écart à reporter dans l'ADR).
   */
  readonly incomplete: boolean;
  /** Y-TECH-02 : dossier de plus de 1 Gio (`FOLDER_WARN_BYTES`), avertissement. Facultatif (anciens faux). */
  readonly folderLarge?: boolean;
  /** Y-TECH-02 : budget de nonces de la clé au-delà du seuil d'alerte (`NONCE_WARN_RECORDS`), avertissement. Facultatif (anciens faux). */
  readonly nonceWarning?: boolean;
  /** Y-10 (ADR 0011 §11.2, §18 points 3 à 6) : registre de l'oubli de Rust après fusion des déclarations lues. */
  readonly forgotten: ForgottenRegistryView;
  /** Y-11 (ADR 0011 §14.3, §18 point 2) : réinitialisation en cours sur cet appareil, vue par Rust ; null : aucune. Facultatif (anciens faux). */
  readonly reset?: ResetView | null;
}

/**
 * Y-11 : réinitialisation vue par Rust au scan (`sync/reset.json`), jamais de clé. `initiator` : cet appareil l'a lancée ; `joined` : il a
 * importé la nouvelle clé d'un autre (sous `.next`). `notice` : annonce à publier sous l'ancienne clé (maître : Rust). `superseded` : perte
 * constatée (époque et auteur gagnants ; null : réinitialisation interrompue). `switched` : bascule terminée par ce scan ; `resumed` :
 * bascule interrompue reprise. `waiting` : appareils connus pas encore réassociés (appareil qui réinitialise).
 */
export interface ResetView {
  readonly role: 'initiator' | 'joined';
  readonly kid: string;
  readonly epoch: EpochId;
  readonly by: DeviceId;
  readonly notice: ResetNotice | null;
  readonly stage: 'created' | 'announced' | 'opened';
  /** Époque de l'état qui porte l'annonce (`n`) : arrivée par fusion seulement depuis elle (§18 point 16, complément 2). */
  readonly noticeEpoch?: EpochId | null;
  /** Perte : époque et auteur gagnants ; `restore` : le gagnant est une époque restaurée sous l'ancienne clé (§18 point 16). */
  readonly superseded: { readonly epoch: EpochId | null; readonly by: DeviceId | null; readonly restore?: boolean } | null;
  /** Registre `superseded` clos par ce scan, son gagnant étant oublié (§18 point 15) : « Réinitialisation interrompue : relancez-la ». */
  readonly closed?: boolean | undefined;
  readonly switching: boolean;
  readonly switched: boolean;
  readonly resumed: boolean;
  readonly waiting: readonly DeviceId[];
}

/** Y-10 : liste maître (ordre d'apprentissage, ne décroît jamais, 64 au plus, publiée telle quelle), terminés, débordement. */
export interface ForgottenRegistryView {
  readonly entries: readonly ForgottenDevice[];
  readonly done: readonly DeviceId[];
  readonly overflow: boolean;
  /** Identifiants dont un état a déjà été accepté (anti-rejeu du registre, identifiants seuls) : base de `seenDevices` (revue point 4). */
  readonly accepted: readonly DeviceId[];
  /** Arrêt définitif (§18 point 12) : hlc de la déclaration qui a oublié cet appareil, persistant chez Rust, jamais effacé. */
  readonly selfForgotten: Hlc | null;
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
  /**
   * Y-10 (§18 point 11) : dernier enregistrement seul (`snap-end`) de l'instantané **annoncé** (`seq` égal à l'annonce, sinon
   * `state-mismatch`) ; `fromRecord` ignoré ; `complete` à un enregistrement, `cloud-pending` (ligne finale incomplète ou absente),
   * `truncated` (dernière ligne qui ne se déchiffre pas).
   */
  readonly tail?: true;
}

/** Entrée de `sync_scan` : appareils déjà connus (`sync_state`), jamais écartés par le plafond de dossiers (section 1.1). */
export interface ScanRequest {
  readonly keep: readonly DeviceId[];
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

/** Forme IPC de `SyncFolderInfo` : Rust rend le nom du dossier (`name`), jamais un libellé composé ni un chemin. */
export interface SyncFolderInfoJson extends Omit<SyncFolderInfo, 'label'> {
  readonly name: string | null;
}

export interface FolderScanJson extends Omit<FolderScan, 'devices'> {
  readonly devices: readonly DeviceScanJson[];
}

/** Entrée (arguments d'`invoke`, `undefined` : aucun) et sortie de chaque commande `sync_*`. */
export interface SyncCommandMap {
  sync_folder_info: { readonly args: undefined; readonly result: SyncFolderInfoJson };
  sync_folder_choose: { readonly args: undefined; readonly result: SyncFolderInfoJson | null };
  sync_folder_forget: { readonly args: { readonly eraseKey: boolean }; readonly result: null };
  sync_bind_device: { readonly args: { readonly deviceId: DeviceId }; readonly result: null };
  sync_key_status: { readonly args: undefined; readonly result: KeyStatus };
  sync_key_create: { readonly args: undefined; readonly result: { readonly kid: string } };
  sync_pairing_open: { readonly args: { readonly mode: PairingMode }; readonly result: null };
  sync_pairing_payload: { readonly args: { readonly renew?: true }; readonly result: PairingPayload };
  sync_key_import: { readonly args: KeyImportInput; readonly result: KeyImportResult };
  sync_pairing_close: { readonly args: undefined; readonly result: null };
  sync_scan: { readonly args: ScanRequest; readonly result: FolderScanJson };
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
  sync_restore_marker_get: { readonly args: undefined; readonly result: RestoreMarker | null };
  sync_restore_marker_clear: { readonly args: undefined; readonly result: null };
  // Lot Y4 (ADR 0011 sections 11.1 et 18) : déclarées à l'étape 0, `not-configured` jusqu'à Y-10 et Y-11.
  sync_device_forget: { readonly args: { readonly deviceId: DeviceId }; readonly result: null };
  sync_forgotten_delete: { readonly args: { readonly deviceId: DeviceId }; readonly result: ForgottenDeleteResult };
  sync_reset_key: { readonly args: undefined; readonly result: { readonly kid: string } };
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
  sync_device_forget: 'main',
  sync_forgotten_delete: 'main',
  sync_reset_key: 'main',
};

/** Les 24 commandes, dans l'ordre de la section 11.1 (même liste que `AppManifest::commands` de `build.rs` ; lot Y1, puis lot Y4). */
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
    /** Y-11 : `nextKid`, `kid` de l'entrée `.next` (nouvelle clé d'une réinitialisation), fait foi pour le moteur ; absent des anciens faux. */
    status(): Promise<KeyStatus>;
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
  /** `keep` : appareils jamais écartés par le plafond de 16 dossiers (connus de `sync_state`) ; son propre dossier l'est toujours. */
  scan(r: ScanRequest): Promise<FolderScan>;
  /** Jamais au-delà de la tête authentifiée ; époque autre que la tête ou segment manquant sous la tête : page `cloud-pending`. */
  readJournal(r: ReadJournalRequest): Promise<ReadPage>;
  /**
   * 1 Mio écrit au plus par appel ; `segment-full` : segment suivant (en-tête compris) ; `hlc-order` si `maxHlc` ne dépasse pas le
   * maximum cumulé de l'époque ; appel vide ou `maxHlc` mal formé : `bad-name` ; époque antérieure : `state-mismatch`.
   */
  appendJournal(r: AppendJournalRequest): Promise<AppendJournalResult>;
  /** `stateSeq` non croissant (toutes époques confondues) ou époque antérieure : `state-mismatch` ; état mal formé : `bad-name`. */
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
  /** Lot Y4, Y-10 (ADR 0011 section 14.2). Étape 0 : les deux méthodes rejettent `not-configured`. */
  readonly forget: {
    /** Fenêtre main : confirmation native, puis déclaration dans `sync/forgotten.json`. */
    device(deviceId: DeviceId): Promise<void>;
    /** Fenêtre main, appelée par le cycle, sans boîte : conditions recalculées par Rust. */
    deleteFiles(deviceId: DeviceId): Promise<ForgottenDeleteResult>;
  };
  /** Lot Y4, Y-11 (ADR 0011 section 14.3). */
  readonly reset: {
    /** Fenêtre main : confirmation native, création ou reprise de K2. Ne renvoie que le kid. */
    start(): Promise<{ readonly kid: string }>;
  };
}

/** `sync_key_status` : présence et `kid` de la clé, `kid` de la nouvelle clé d'une réinitialisation (Y-11), jamais la clé. */
export interface KeyStatus {
  readonly present: boolean;
  readonly kid: string | null;
  readonly nextKid?: string | null;
  /** Y-11 (§18 point 17) : dernier refus de `sync_key_import` pour ce dossier (`sync/import-failure.json`), ou null. */
  readonly importFailure?: { readonly code: SyncErrorCode; readonly at: IsoDateTime } | null;
}

/** Sortie de `sync_forgotten_delete` (Y-10) : `complete` faux s'il reste des fichiers (10 000 entrées au plus par appel). */
export interface ForgottenDeleteResult {
  readonly deleted: number;
  readonly complete: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Service exposé par le conteneur (implémenté par src/sync, lot Y2)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Phases de la synchro. Liste unique : `SYNC_PHASES` de `src/domain/syncBanners.ts` (A-09 critère 9 b) ; une phase nouvelle (Y-10,
 * Y-11) s'y ajoute, et la compilation échoue tant que son bandeau (`phaseBanner`) et sa ligne de Réglages (`statusLine`) manquent.
 */
export type SyncPhase = DomainSyncPhase;
export { SYNC_PHASES, SYNC_WARNINGS, type SyncWarningCode } from '../../domain/syncBanners';

export type DeviceSyncStatus = 'active' | 'expired' | 'newer-major' | 'clock-ahead' | 'corrupt' | 'foreign' | 'rollback' | 'forgotten';

export interface SyncDeviceStatus {
  readonly deviceId: DeviceId;
  readonly platform: SyncDevicePlatform;
  readonly self: boolean;
  readonly lastReadAt: IsoDateTime | null;
  readonly status: DeviceSyncStatus;
  /** Y-07 : numéro d'application publié par l'appareil (« 1.4.0 »), si connu. Facultatif. */
  readonly appVersion?: string | null;
  /** Y-07 : version plus récente que l'appareil local (`'schema'` : lu ; `'major'` : lecture suspendue), sinon null. Facultatif. */
  readonly newer?: 'schema' | 'major' | null;
  /**
   * Y-10 (audit a) : faux : appareil jamais lu (dossier sans état authentifié, ou seulement cité dans un accusé), montré pour pouvoir
   * l'oublier ; nom neutre (« Appareil » et 8 caractères), jamais une plateforme inventée. Facultatif.
   */
  readonly seen?: boolean;
}

export interface SyncStatus {
  readonly phase: SyncPhase;
  readonly lastSyncAt: IsoDateTime | null;
  /** Nom du dossier (`SyncFolderInfo.label`, jamais un chemin) ; le libellé affiché est composé par l'interface avec `folderKind`. */
  readonly folderLabel: string | null;
  /** Nature du dossier (`SyncFolderInfo.kind`) : « iCloud Drive / <nom> » pour `icloud`. Ajout du lot Y2 (fusion avec Y1), facultatif. */
  readonly folderKind?: SyncFolderInfo['kind'] | null;
  readonly devices: readonly SyncDeviceStatus[];
  readonly pendingFiles: readonly string[];
  readonly conflictsThisWeek: number;
  /** Nouvel appareil (Y-06) : enregistrements lus / total. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /**
   * Code de la dernière erreur de cycle (phase `error`, ou `waiting-icloud` causé par `cloud-pending`) : choisit le texte explicite de
   * la ligne de Réglages (Y-05 critère 2). Ajout du lot Y2, facultatif.
   */
  readonly errorCode?: SyncErrorCode | null;
  /** Appareil dont l'horloge est en avance (phase `clock-ahead`, Y-09 critère 10). Ajout du lot Y2, facultatif. */
  readonly clockAheadDevice?: DeviceId | null;
  /**
   * Y-07 (exigence d'Ali) : champs reçus d'une version plus récente dont la réintégration a échoué au dernier démarrage (sans contenu :
   * nombre, tables, date, noms d'erreur) ; absent ou null : aucun échec. Facultatif.
   */
  readonly reintegrationFailure?: ReintegrationFailure | null;
  /**
   * Y-10 (exigence d'Ali : aucun échec silencieux) : échec d'un oubli ou d'une suppression (`sync_meta.forgetFailure`) et suppressions
   * des fichiers d'appareils oubliés en attente (`sync_meta.forgetDeletions`), lus à la fin de chaque cycle ; absent : rien. Facultatif.
   */
  readonly forget?: SyncForgetStatus | null;
  /**
   * A-09 (revue, point 3) : heure de début du cycle en cours (ms, horloge du service), posée seulement pendant la phase `syncing` ; le
   * bandeau « Synchro en cours » compte son seuil depuis elle. Facultatif.
   */
  readonly cycleStartedAt?: number | null;
  /**
   * Y-11 (exigence d'Ali : aucun échec silencieux) : réinitialisation en cours, en échec, à réassocier, ou terminée
   * (`sync_meta.resetState`), lue à la fin de chaque cycle ; absent ou null : rien. Facultatif.
   */
  readonly reset?: SyncResetStatus | null;
  /**
   * Y-TECH-02 : avertissements du dernier scan (budget de nonces, dossier de plus de 1 Gio, plus de 16 dossiers, scan incomplet), jamais
   * un blocage ; gardés quand un cycle échoue avant le scan. Absent : aucun. Facultatif.
   */
  readonly warnings?: readonly SyncWarningCode[];
  /** Y-TECH-02 (§19 point 7) : une lecture de l'état local de la synchro a échoué (`state-unreadable`) ; absent : non. Facultatif. */
  readonly stateUnreadable?: boolean;
}

/** Y-11 : étape de la réinitialisation (`sync_meta.resetState`, critère 17). */
export type ResetStep = 'start' | 'announced' | 'snapshot' | 'waiting-devices' | 'switching' | 'superseded' | 'required' | 'joined' | 'done';

/** Y-11 : échec persistant (code, heure, étape ; jamais de contenu ni de clé), effacé à la réussite de l'étape ou à la fin de la bascule. */
export interface ResetFailure {
  readonly code: SyncErrorCode;
  readonly at: IsoDateTime;
  readonly step: ResetStep;
}

/**
 * Y-11 : état affiché de la réinitialisation. `initiator` : cet appareil réinitialise (`waiting` : appareils pas encore réassociés ;
 * `reminder` : 30 jours dépassés, rappel sans action) ; `joined` : réassocié, bascule en attente ; `required` : cet appareil doit être
 * associé de nouveau (`by` : appareil de l'annonce gagnante ; `superseded` : sa propre réinitialisation a perdu). `done` : bascule
 * terminée (`resumed` : reprise après un arrêt), jusqu'à ce que l'écran soit fermé.
 */
export interface SyncResetStatus {
  readonly role: 'initiator' | 'joined' | 'required';
  readonly step: ResetStep;
  readonly by: DeviceId | null;
  readonly superseded: boolean;
  readonly waiting: readonly DeviceId[];
  readonly reminder: boolean;
  readonly startedAt: IsoDateTime;
  readonly resumed: boolean;
  readonly failure: ResetFailure | null;
  /** §18 point 16 : réinitialisation perdue face à une restauration appliquée partout sur `by` (« relancez-la »). */
  readonly restore?: boolean | undefined;
  /** §18 point 15 : perte close (gagnant oublié) : « Réinitialisation interrompue : relancez-la ». */
  readonly closed?: boolean | undefined;
}

/** Y-11 : issue de « Réinitialiser la synchronisation ». */
export type ResetOutcome =
  | { readonly kind: 'started'; readonly switched: boolean }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'lagging'; readonly device: DeviceId | null }
  | { readonly kind: 'failed'; readonly code: SyncErrorCode };

/** Y-10 : étape d'un oubli qui a échoué. `declare` : `sync_device_forget` ; `delete` : `sync_forgotten_delete` ; `rejoin` : « Associer de nouveau ». */
/** `revived` : jamais gardé comme échec ; forme du bandeau « oubli en échec » d'un oubli annulé (§18 point 12). */
export type ForgetStep = 'declare' | 'delete' | 'rejoin' | 'overflow' | 'revived';

/** Y-10 : échec persistant (sans contenu, sans clé, sans chemin), effacé seulement à la réussite de la même étape pour le même appareil. */
export interface ForgetFailure {
  readonly deviceId: DeviceId;
  readonly code: string;
  readonly at: IsoDateTime;
  readonly step: ForgetStep;
}

/**
 * Y-10 : suppression des fichiers d'un appareil oublié. `waiting` : un appareil actif n'a pas encore accusé (`waitingFor`, null si
 * inconnu) ; `deleting` : commencée, le cycle suivant continue ; `strays` : fichiers non reconnus laissés dans le dossier ; `done`.
 */
export interface ForgetDeletionStatus {
  readonly deviceId: DeviceId;
  /** `finalizing` : dossier déjà disparu, mais Rust ne l'a pas encore inscrit dans `done` (conditions pas encore réunies, revue point 5). */
  /** `no-snapshot` : aucun instantané éligible ne couvre cet oublié (trou, arrivée ou reprise en attente, §18 point 11). */
  readonly state: 'waiting' | 'deleting' | 'finalizing' | 'no-snapshot' | 'strays' | 'done';
  readonly waitingFor: DeviceId | null;
}

export interface SyncForgetStatus {
  readonly failure: ForgetFailure | null;
  readonly deletions: readonly ForgetDeletionStatus[];
  /** Oublis annulés (§18 point 12) : ligne « Oubli annulé » avec « Oublier cet appareil », bandeau « oubli en échec ». */
  readonly revived?: readonly DeviceId[];
}

/** Y-10 : issue de « Oublier cet appareil » (`cancelled` : la boîte native a été refusée ou fermée, rien n'est écrit). */
export type ForgetOutcome = { readonly kind: 'done' } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly code: string };

/** Y-10 : issue de « Associer de nouveau » (`restart` : l'app doit être relancée sous sa nouvelle identité). */
export type RejoinOutcome = { readonly kind: 'restart' } | { readonly kind: 'failed'; readonly code: string };

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

/**
 * Service de synchro tel que le conteneur l'expose (`AppContainer.sync`) : `SyncService` et la fenêtre de choix après restauration.
 * Défini ici (couche platform) pour que le conteneur, les stores et leurs faux n'importent jamais `src/sync` (avenant « Amorce »
 * point 7) ; implémenté par `src/sync/service.ts`.
 */
export interface SyncEngineService extends SyncService {
  /** Options de la fenêtre de choix après restauration (null : pas de marqueur). */
  restoreContext(): Promise<RestoreContext | null>;
  /** Cycle en cours (tests, budget de « Quitter »). */
  readonly running: () => Promise<void> | null;
  /**
   * Y-10 : « Oublier cet appareil » : confirmation native de Rust, déclaration, puis deux cycles (publication, application). Ne rejette
   * jamais : un échec est rendu et gardé dans `sync_meta.forgetFailure` (visible dans `status().forget`).
   */
  forgetDevice(deviceId: DeviceId): Promise<ForgetOutcome>;
  /**
   * Y-10 (D2) : « Associer de nouveau » sur l'appareil oublié : ses écritures non lues des autres sont republiées sous une nouvelle
   * identité, le dossier est délié (clé gardée) ; l'app doit ensuite être relancée (puis le dossier choisi de nouveau). Ne rejette jamais.
   */
  rejoin(): Promise<RejoinOutcome>;
  /**
   * Y-11 : « Réinitialiser la synchronisation » : un cycle, précondition (« Synchronisez d'abord »), confirmation native de Rust et `K2`,
   * puis les cycles qui annoncent, ouvrent l'époque `n+1` et basculent si aucun autre appareil n'est attendu. Ne rejette jamais : un
   * échec est rendu et gardé dans `sync_meta.resetState` (visible dans `status().reset`).
   */
  resetSync(): Promise<ResetOutcome>;
  /** Y-11 : efface l'état « réinitialisation terminée » (ou un échec de lancement abandonné) affiché dans Réglages. */
  dismissReset(): Promise<void>;
}

/** Fenêtre de choix après une restauration P-04 (ADR 0010 règles 3 et 4, ADR 0011 section 9). */
export interface RestoreContext {
  readonly marker: RestoreMarker;
  /** Options proposées (règle 4 : seulement « Appliquer partout » si une suppression postérieure a déjà été purgée). */
  readonly options: readonly RestoreOption[];
  /**
   * Y-11 (§18 point 16) : réinitialisation en cours : « Appliquer partout » retiré (`reset-in-progress`) ; dans le cas de la règle 4, aucune
   * option (`reset-finish` : « terminez-la sur l'appareil qui réinitialise »). Y-TECH-02 : `scan-failed` : le dossier n'a pas pu être
   * vérifié (réinitialisation, purge plus récente) : « Appliquer partout » retiré par prudence.
   */
  readonly notice?: 'reset-in-progress' | 'reset-finish' | 'scan-failed' | null;
  /** Dernier choix refusé ou en échec (code, heure, option), gardé jusqu'à un choix appliqué (aucun échec silencieux, QA-1). */
  readonly failure?: RestoreFailure | null;
}

/** Échec d'un choix après restauration (`sync_meta.restoreFailure`). */
export interface RestoreFailure {
  readonly code: SyncErrorCode;
  readonly at: IsoDateTime;
  readonly option: RestoreOption;
}

/** État avant le premier cycle (et sans synchro) : non configurée, rien de connu. */
export const INITIAL_STATUS: SyncStatus = {
  phase: 'not-configured',
  lastSyncAt: null,
  folderLabel: null,
  folderKind: null,
  devices: [],
  pendingFiles: [],
  conflictsThisWeek: 0,
  progress: null,
  errorCode: null,
  clockAheadDevice: null,
};
