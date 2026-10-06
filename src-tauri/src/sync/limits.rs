//! Bornes de la synchronisation (ADR 0011, sections 1.3, 1.6, 2, 2.1 et 10.3). Mêmes valeurs que `src/domain/sync/limits.ts`
//! (test croisé : `tests/desktop/sync_crypto.rs`). Tout dépassement est refusé avant l'allocation, le décodage ou l'hydratation.

pub const KIB: u64 = 1024;
pub const MIB: u64 = 1024 * KIB;
pub const GIB: u64 = 1024 * MIB;

/// En-tête en clair (ligne 1), lu jusqu'au premier `\n`.
pub const MAX_HEADER_BYTES: usize = 1024;
/// Ligne chiffrée `<sm>.<sv>.<base64url>`, contrôlée avant le décodage base64.
pub const MAX_RECORD_LINE_BYTES: usize = 360_000;
/// Texte clair d'un enregistrement avant bourrage.
pub const MAX_RECORD_PLAINTEXT_BYTES: usize = 256 * 1024;
/// Palier de bourrage.
pub const PADDING_BLOCK_BYTES: usize = 4 * 1024;
pub const PADDING_LENGTH_PREFIX_BYTES: usize = 4;
pub const MAX_PADDED_PLAINTEXT_BYTES: usize = MAX_RECORD_PLAINTEXT_BYTES + PADDING_BLOCK_BYTES;
pub const NONCE_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;

/// Segment : ajout refusé s'il ferait dépasser 1 Mio un segment non vide (en-tête compris).
pub const SEGMENT_ROTATE_BYTES: u64 = MIB;
/// Un appel `sync_append_journal` : 1 Mio de lignes chiffrées au plus (octets écrits, `\n` compris).
pub const MAX_APPEND_CALL_BYTES: u64 = MIB;
/// Bornes de lecture.
pub const MAX_SEGMENT_BYTES: u64 = 8 * MIB;
pub const MAX_SNAPSHOT_BYTES: u64 = 256 * MIB;
/// `state.ctx` : en-tête et une seule ligne chiffrée, chacun suivi de `\n`.
pub const MAX_STATE_FILE_BYTES: u64 = (MAX_HEADER_BYTES + 1 + MAX_RECORD_LINE_BYTES + 1) as u64;
/// Pages de texte clair échangées par l'IPC.
pub const MAX_IPC_PAGE_BYTES: usize = 2 * 1024 * 1024;

pub const MAX_STATE_ACKS: usize = 64;
pub const MAX_STATE_FORGOTTEN: usize = 64;
pub const MAX_DEVICE_FOLDERS: usize = 16;
pub const MAX_SCAN_ENTRIES_PER_FOLDER: usize = 10_000;

/// Taille totale du dossier : avertissement, puis plus aucune hydratation (`folder-too-large`).
pub const FOLDER_WARN_BYTES: u64 = GIB;
pub const FOLDER_STOP_BYTES: u64 = 4 * GIB;

/// Appairage (section 10.3) et confirmations natives (section 2.1).
pub const PAIRING_VALIDITY_MS: u64 = 5 * 60_000;
pub const PAIRING_CLOCK_TOLERANCE_MS: u64 = 2 * 60_000;
/// Appareil absent depuis plus de 180 jours (`expired`, section 5.5) : même valeur que `DEVICE_EXPIRY_MS` de `limits.ts` (Y-11 : précondition).
pub const DEVICE_EXPIRY_MS: u64 = 180 * 86_400_000;
pub const CONSENT_WINDOW_MS: u64 = 10 * 60_000;
pub const CONSENT_MAX_SHOW: usize = 3;
pub const CONSENT_MAX_IMPORT: usize = 5;
pub const CONSENT_BLOCK_MS: u64 = 10 * 60_000;

/// Hydratation d'un fichier dans le nuage (section 6.2).
pub const HYDRATE_FILE_TIMEOUT_MS: u64 = 60_000;
pub const HYDRATE_CYCLE_TIMEOUT_MS: u64 = 3 * 60_000;

/// Budget de nonces par clé (audit B1) : alerte, puis refus de chiffrer (`key-exhausted`).
pub const NONCE_WARN_RECORDS: u64 = 1 << 30;
pub const NONCE_MAX_RECORDS: u64 = 1 << 32;

/// Taille du texte clair bourré : `u32 ‖ JSON ‖ zéros` au multiple de 4 Kio supérieur (4 Kio au minimum).
pub const fn padded_plaintext_bytes(json_bytes: usize) -> usize {
    let raw = PADDING_LENGTH_PREFIX_BYTES + json_bytes;
    let blocks = raw.div_ceil(PADDING_BLOCK_BYTES);
    if blocks == 0 {
        PADDING_BLOCK_BYTES
    } else {
        blocks * PADDING_BLOCK_BYTES
    }
}

/// Longueur base64url sans remplissage de `n` octets.
pub const fn base64url_len(n: usize) -> usize {
    (n * 4).div_ceil(3)
}

/// Octets écrits sur disque pour un enregistrement : `<sm>.<sv>.` + base64url(nonce ‖ texte bourré chiffré ‖ étiquette) + `\n`.
pub fn encrypted_line_bytes(json_bytes: usize, sm: u32, sv: u32) -> usize {
    let sealed = NONCE_BYTES + padded_plaintext_bytes(json_bytes) + TAG_BYTES;
    format!("{sm}.{sv}.").len() + base64url_len(sealed) + 1
}

/// Entrées listées au plus par opération (scan, reconstruction de `own.json`, recherche de données ; audit S2), toutes listes confondues.
pub const MAX_SCAN_ENTRIES_TOTAL: usize = 50_000;
/// Dossiers d'époque listés au plus par appareil retenu (les plus récents).
pub const MAX_EPOCHS_PER_DEVICE: usize = 64;
/// `state.ctx` d'appareils non protégés lus au plus par opération (candidats au plafond de 16 dossiers, import, reconstruction).
pub const MAX_STATE_CANDIDATES: usize = 64;
