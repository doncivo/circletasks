/**
 * Bornes de la synchronisation (ADR 0011, sections 1.3, 1.6 et 4.4 ; Y-02, Y-07, Y-09).
 *
 * Mêmes valeurs que `src-tauri/src/sync/limits.rs` (test croisé sur `tests/fixtures/sync/vectors.json`, lot Y1). Tout dépassement est
 * refusé avant l'allocation, le décodage ou l'hydratation. Module pur : constantes et calculs de taille, sans I/O.
 */

export const KIB = 1024;
export const MIB = 1024 * KIB;
export const GIB = 1024 * MIB;

/** En-tête de fichier en clair (première ligne) : 1 Kio au plus, lu jusqu'au premier `\n`. */
export const MAX_HEADER_BYTES = 1 * KIB;
/** Ligne chiffrée `<sm>.<sv>.<base64url>` : longueur contrôlée avant le décodage base64. */
export const MAX_RECORD_LINE_BYTES = 360_000;
/** Texte clair d'un enregistrement, avant bourrage. */
export const MAX_RECORD_PLAINTEXT_BYTES = 256 * KIB;
/** Palier de bourrage du texte clair (audit M1) : multiple supérieur, 4 Kio au minimum. */
export const PADDING_BLOCK_BYTES = 4 * KIB;
/** Préfixe de longueur du texte clair bourré (u32 gros-boutiste). */
export const PADDING_LENGTH_PREFIX_BYTES = 4;
/** Nonce AES-GCM (96 bits) et étiquette (128 bits). */
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** Taille du texte clair d'un enregistrement d'instantané `snap-rows` (découpage par taille, audit M1). */
export const SNAPSHOT_CHUNK_PLAINTEXT_BYTES = 64 * KIB;

/** Rotation : nouveau segment au-delà de 1 Mio ; ajout refusé s'il ferait dépasser 1 Mio un segment non vide (`segment-full`). */
export const SEGMENT_ROTATE_BYTES = 1 * MIB;
/** Un appel `sync_append_journal` porte 1 Mio au plus (`too-large`). */
export const MAX_APPEND_CALL_BYTES = 1 * MIB;
/** Borne de lecture d'un segment. */
export const MAX_SEGMENT_BYTES = 8 * MIB;
/** Borne de lecture d'un instantané. */
export const MAX_SNAPSHOT_BYTES = 256 * MIB;
/** Pages de texte clair échangées par l'IPC (section 6.4). */
export const MAX_IPC_PAGE_BYTES = 2 * MIB;

/** Accusés et appareils oubliés dans un `state.ctx`. */
export const MAX_STATE_ACKS = 64;
export const MAX_STATE_FORGOTTEN = 64;
/** Dossiers d'appareils pris en compte dans `devices/`. */
export const MAX_DEVICE_FOLDERS = 16;
/** Entrées listées par dossier pendant le `scan`. */
export const MAX_SCAN_ENTRIES_PER_FOLDER = 10_000;

/** Taille totale du dossier : avertissement, puis plus aucune hydratation (`folder-too-large`). */
export const FOLDER_WARN_BYTES = 1 * GIB;
export const FOLDER_STOP_BYTES = 4 * GIB;

/** Plafonds des tables locales. */
export const MAX_PARKED_OPS = 10_000;
export const MAX_UNKNOWN_FIELDS = 50_000;
export const MAX_UNKNOWN_BYTES = 16 * MIB;
export const MAX_CONFLICT_LOG_ROWS = 10_000;
export const CONFLICT_LOG_RETENTION_MONTHS = 12;

/** Application par lots de 500 opérations au plus (section 10.2) ; pages de 500 lignes (section 9.1). */
export const APPLY_BATCH_OPS = 500;
export const PAGE_ROWS = 500;

/** Dérive d'horloge tolérée (section 4.4) : 1 h, mesurée sur l'horloge physique. */
export const HLC_MAX_DRIFT_MS = 3_600_000;

const DAY_MS = 86_400_000;
/** Rétention (sections 5.3 à 5.5). */
export const TOMBSTONE_GRACE_MS = 30 * DAY_MS;
export const SEGMENT_PURGE_AGE_MS = 30 * DAY_MS;
export const DEVICE_EXPIRY_MS = 180 * DAY_MS;
export const SNAPSHOT_INTERVAL_MS = 7 * DAY_MS;
export const SNAPSHOTS_KEPT_PER_EPOCH = 2;
export const OLD_EPOCH_RETENTION_MS = 30 * DAY_MS;
/** `state.ctx` réécrit pour le seul `lastSyncHlc` au plus toutes les 30 minutes (audit M1). */
export const STATE_REFRESH_MS = 30 * 60_000;

/** Déclenchement (section 10.1) et appairage (section 10.3). */
export const SYNC_INTERVAL_MS = 5 * 60_000;
export const QUIT_SYNC_BUDGET_MS = 5_000;
export const PAIRING_VALIDITY_MS = 5 * 60_000;
export const PAIRING_CLOCK_TOLERANCE_MS = 2 * 60_000;
export const PAIRING_RESCAN_MS = 10_000;
/** Hydratation d'un fichier dans le nuage (section 6.2). */
export const HYDRATE_FILE_TIMEOUT_MS = 60_000;
export const HYDRATE_CYCLE_TIMEOUT_MS = 3 * 60_000;

/** Budget de nonces par clé (audit B1) : alerte, puis refus de chiffrer (`key-exhausted`). */
export const NONCE_WARN_RECORDS = 2 ** 30;
export const NONCE_MAX_RECORDS = 2 ** 32;

/** Longueur en octets UTF-8 d'un texte (TextEncoder : disponible dans le navigateur, la WebView et Node). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Taille du texte clair bourré : `u32 ‖ JSON ‖ zéros`, au multiple de 4 Kio supérieur (4 Kio au minimum). */
export function paddedPlaintextBytes(jsonBytes: number): number {
  if (!Number.isSafeInteger(jsonBytes) || jsonBytes < 0) throw new RangeError('taille de texte clair invalide');
  const raw = PADDING_LENGTH_PREFIX_BYTES + jsonBytes;
  return Math.max(PADDING_BLOCK_BYTES, Math.ceil(raw / PADDING_BLOCK_BYTES) * PADDING_BLOCK_BYTES);
}

/** Longueur base64url sans remplissage de `n` octets. */
export function base64UrlLength(n: number): number {
  return Math.ceil((n * 4) / 3);
}

/**
 * Taille sur disque d'une ligne chiffrée, `\n` compris : `<sm>.<sv>.` + base64url(nonce ‖ texte bourré chiffré ‖ étiquette) + `\n`.
 * Sert aux plafonds de segment et d'appel (mesurés en octets écrits, docs/decisions.md 2026-10-05).
 */
export function encryptedLineBytes(jsonBytes: number, sm: number, sv: number): number {
  const sealed = NONCE_BYTES + paddedPlaintextBytes(jsonBytes) + TAG_BYTES;
  return `${String(sm)}.${String(sv)}.`.length + base64UrlLength(sealed) + 1;
}
