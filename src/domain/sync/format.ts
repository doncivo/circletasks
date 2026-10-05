/**
 * Format de la synchronisation par iCloud Drive (ADR 0011, sections 1, 3.1, 5.1 et 11.2 ; Y-02, Y-07, Y-08, Y-09).
 *
 * Module pur : constantes du format sur disque, noms stricts, codes d'erreur, structures publiées (état d'appareil, accusés,
 * enregistrements de journal et d'instantané) et validateurs. Aucune I/O, aucun état. Les noms et expressions sont les mêmes que
 * `src-tauri/src/sync/names.rs` (lot Y1) ; l'analyse stricte du texte clair déchiffré vit dans `parse.ts` (lot Y2).
 */

import type { DeviceId, Hlc, IsoDateTime } from '../types';
import {
  MAX_HEADER_BYTES,
  MAX_PADDED_PLAINTEXT_BYTES,
  MAX_RECORD_LINE_BYTES,
  MAX_STATE_ACKS,
  MAX_STATE_FORGOTTEN,
  NONCE_BYTES,
  PADDING_BLOCK_BYTES,
  TAG_BYTES,
  utf8Bytes,
} from './limits';

export * from './limits';

// ---------------------------------------------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------------------------------------------

/** `sm` : version majeure du format de synchro (Y-07). Égale à la constante Rust (test croisé). */
export const SYNC_FORMAT_MAJOR = 1;

/** Préfixe de version des AAD (`ct/1`, section 2). */
export const AAD_VERSION = 'ct/1';

// ---------------------------------------------------------------------------------------------------------------------------------
// Noms stricts (section 1.1)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Dossier racine dans iCloud Drive (PRD 7) et dossier des appareils. */
export const SYNC_ROOT_FOLDER = 'CircleTasks';
export const DEVICES_FOLDER = 'devices';
/** État publié d'un appareil. */
export const STATE_FILE = 'state.ctx';
/** Réservé à la transition de Y-11 (section 14.3) : jamais écrit ni lu jusqu'au lot Y4. */
export const STATE_NEXT_FILE = 'state.next.ctx';
export const JOURNAL_EXTENSION = '.ctj';
export const SNAPSHOT_EXTENSION = '.cts';
export const STATE_EXTENSION = '.ctx';
export const TEMP_EXTENSION = '.tmp';

/** Plus grands numéros représentables : époque sur 4 chiffres, segment et instantané sur 8. */
export const MAX_EPOCH_NUMBER = 9_999;
export const MAX_FILE_NUMBER = 99_999_999;

const UUID_V4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_V4_RE = new RegExp(`^${UUID_V4}$`);
const EPOCH_RE = new RegExp(`^e(\\d{4})-(${UUID_V4})$`);
const SEGMENT_RE = /^j-(\d{8})\.ctj$/;
const SNAPSHOT_RE = /^s-(\d{8})\.cts$/;
/** hlc strict (ADR 0005, audit M4) : `<15 chiffres>-<4 hexa>-<uuid v4 minuscule>`, validé avant toute comparaison. */
const STRICT_HLC_RE = new RegExp(`^\\d{15}-[0-9a-f]{4}-${UUID_V4}$`);
/** `kid` : 8 octets en hexadécimal minuscule. */
const KID_RE = /^[0-9a-f]{16}$/;

/** Identifiant d'époque `e<4 chiffres>-<uuid de l'appareil qui l'ouvre>` (section 9). */
export type EpochId = string & { readonly __brand: 'EpochId' };

/** `device_id` publié : UUID v4 en minuscules (plus strict que `isId`, qui accepte les versions 1 à 8). */
export function isSyncDeviceId(value: unknown): value is DeviceId {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

/** hlc au format strict ; à appeler avant toute comparaison d'un hlc reçu (section 3.1). */
export function isStrictHlc(value: unknown): value is Hlc {
  return typeof value === 'string' && STRICT_HLC_RE.test(value);
}

export function isKid(value: unknown): value is string {
  return typeof value === 'string' && KID_RE.test(value);
}

export function isEpochId(value: unknown): value is EpochId {
  if (typeof value !== 'string') return false;
  const m = EPOCH_RE.exec(value);
  return m !== null && Number(m[1]) >= 1;
}

export function epochId(n: number, opener: DeviceId): EpochId {
  if (!Number.isInteger(n) || n < 1 || n > MAX_EPOCH_NUMBER) throw new RangeError('numéro d’époque invalide');
  if (!isSyncDeviceId(opener)) throw new TypeError('identifiant d’appareil invalide');
  return `e${String(n).padStart(4, '0')}-${opener}` as EpochId;
}

export function parseEpochId(value: string): { readonly n: number; readonly opener: DeviceId } | null {
  const m = EPOCH_RE.exec(value);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const n = Number(m[1]);
  return n >= 1 ? { n, opener: m[2] as DeviceId } : null;
}

/** Ordre des époques (section 9) : numéro, puis UUID de l'ouvreur. Les deux arguments doivent être valides. */
export function compareEpochs(a: EpochId, b: EpochId): number {
  const pa = parseEpochId(a);
  const pb = parseEpochId(b);
  if (!pa || !pb) throw new TypeError('époque invalide');
  if (pa.n !== pb.n) return pa.n - pb.n;
  return pa.opener < pb.opener ? -1 : pa.opener > pb.opener ? 1 : 0;
}

/** Numéro de segment ou d'instantané valide (1 à 99 999 999). */
export function isFileNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FILE_NUMBER;
}

export function segmentFileName(n: number): string {
  if (!isFileNumber(n)) throw new RangeError('numéro de segment invalide');
  return `j-${String(n).padStart(8, '0')}${JOURNAL_EXTENSION}`;
}

export function snapshotFileName(n: number): string {
  if (!isFileNumber(n)) throw new RangeError('numéro d’instantané invalide');
  return `s-${String(n).padStart(8, '0')}${SNAPSHOT_EXTENSION}`;
}

/** Nature d'un fichier reconnu dans un dossier d'appareil ou d'époque. */
export type SyncFileName =
  | { readonly kind: 'state' }
  | { readonly kind: 'segment'; readonly n: number }
  | { readonly kind: 'snapshot'; readonly n: number };

/**
 * Reconnaît un nom de fichier strict. Tout autre nom (copie de conflit iCloud « state 2.ctx », `*.tmp`, `state.next.ctx` réservé,
 * fichier étranger) renvoie null : il est ignoré, jamais lu ni supprimé.
 */
export function parseSyncFileName(name: string): SyncFileName | null {
  if (name === STATE_FILE) return { kind: 'state' };
  const segment = SEGMENT_RE.exec(name);
  if (segment?.[1] !== undefined) {
    const n = Number(segment[1]);
    return isFileNumber(n) ? { kind: 'segment', n } : null;
  }
  const snapshot = SNAPSHOT_RE.exec(name);
  if (snapshot?.[1] !== undefined) {
    const n = Number(snapshot[1]);
    return isFileNumber(n) ? { kind: 'snapshot', n } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// En-tête en clair (section 1.2)
// ---------------------------------------------------------------------------------------------------------------------------------

export type FileHeaderKind = 'ct-j' | 'ct-s' | 'ct-state';
const HEADER_KINDS: readonly FileHeaderKind[] = ['ct-j', 'ct-s', 'ct-state'];
const HEADER_KEYS = ['dev', 'e', 'f', 'kid', 'n', 'sm'] as const;

/** En-tête JSON de la ligne 1 : exactement ces six clés. `n` = segment, instantané ou `stateSeq` (`state.ctx`). */
export interface FileHeader {
  readonly f: FileHeaderKind;
  readonly sm: number;
  readonly kid: string;
  readonly dev: DeviceId;
  readonly e: EpochId;
  readonly n: number;
}

/**
 * Analyse stricte d'un en-tête (sans le `\n`) : 1 Kio au plus, objet JSON à six clés exactement, types et expressions vérifiés.
 * Renvoie null en cas d'écart (`bad-header`). La correspondance au chemin se contrôle ensuite par `headerMatchesPath`.
 */
export function parseFileHeader(line: string): FileHeader | null {
  if (utf8Bytes(line) > MAX_HEADER_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== HEADER_KEYS.length || keys.some((key, i) => key !== HEADER_KEYS[i])) return null;
  // Même refus que serde (`deny_unknown_fields`) : clé répétée (JSON.parse garderait la dernière) et nombre non entier (`1.0`, `1e0`).
  if (!hasStrictJsonShape(line, HEADER_KEYS.length)) return null;
  const h = value as Record<string, unknown>;
  if (typeof h['f'] !== 'string' || !HEADER_KINDS.includes(h['f'] as FileHeaderKind)) return null;
  if (typeof h['sm'] !== 'number' || !Number.isInteger(h['sm']) || h['sm'] < 1) return null;
  if (!isKid(h['kid']) || !isSyncDeviceId(h['dev']) || !isEpochId(h['e'])) return null;
  const n = h['n'];
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) return null;
  if (h['f'] !== 'ct-state' && !isFileNumber(n)) return null;
  return { f: h['f'] as FileHeaderKind, sm: h['sm'], kid: h['kid'], dev: h['dev'], e: h['e'], n };
}

/**
 * Contrôle lexical d'un texte JSON déjà accepté par `JSON.parse`, pour refuser ce que serde refuse et que `JSON.parse` accepte
 * (`deny_unknown_fields`, entiers non signés) : le nombre de clés de premier niveau, répétitions comprises (JSON.parse garde la
 * dernière), doit valoir `keys`, et tout nombre doit être un entier canonique positif ou nul (ni `1.0`, ni `1e0`, ni `-1`, ni `01`).
 * Analyse caractère par caractère : chaînes et échappements sont suivis, une valeur ne peut pas imiter une clé.
 */
export function hasStrictJsonShape(text: string, keys: number): boolean {
  let depth = 0;
  let count = 0;
  let inString = false;
  let escaped = false;
  let stringAtTop = false;
  let awaitingColon = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        inString = false;
        awaitingColon = stringAtTop;
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (awaitingColon) {
      awaitingColon = false;
      if (c === ':') {
        count += 1;
        continue;
      }
    }
    if (c === '"') {
      inString = true;
      stringAtTop = depth === 1;
    } else if (c === '{' || c === '[') {
      depth += 1;
    } else if (c === '}' || c === ']') {
      depth -= 1;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let end = i;
      while (end < text.length && /[0-9.eE+-]/.test(text[end] ?? '')) end += 1;
      if (!/^(0|[1-9]\d*)$/.test(text.slice(i, end))) return false;
      i = end - 1;
    }
  }
  return count === keys;
}

/** Emplacement d'un fichier : dossier d'appareil, dossier d'époque (null pour `state.ctx`) et nom. */
export interface SyncFilePath {
  readonly deviceId: DeviceId;
  readonly epoch: EpochId | null;
  readonly file: SyncFileName;
}

/**
 * L'en-tête correspond-il au chemin (audit B2) ? `dev` = dossier d'appareil, `e` = dossier d'époque (pour `state.ctx`, l'époque
 * annoncée), `n` = numéro du nom, `f` = extension.
 */
export function headerMatchesPath(header: FileHeader, path: SyncFilePath): boolean {
  if (header.dev !== path.deviceId) return false;
  switch (path.file.kind) {
    case 'state':
      // L'époque d'un `state.ctx` doit exister : l'appelant passe l'époque attendue s'il la connaît.
      return header.f === 'ct-state' && (path.epoch === null || header.e === path.epoch);
    case 'segment':
      return header.f === 'ct-j' && header.e === path.epoch && header.n === path.file.n;
    case 'snapshot':
      return header.f === 'ct-s' && header.e === path.epoch && header.n === path.file.n;
  }
}

/**
 * Préfixe d'une ligne chiffrée `<sm>.<sv>.<base64url>` (section 1.2), lu avant tout déchiffrement (Y-07). La longueur est contrôlée
 * avant le reste. Renvoie null pour une ligne invalide (corruption).
 */
export function parseRecordLinePrefix(line: string): { readonly sm: number; readonly sv: number; readonly payload: string } | null {
  if (line.length > MAX_RECORD_LINE_BYTES) return null;
  // Entiers canoniques (sans zéro de tête) : `sm` et `sv` entrent dans l'AAD, une seule écriture possible par valeur.
  const m = /^([1-9]\d{0,5})\.([1-9]\d{0,5})\.([A-Za-z0-9_-]+)$/.exec(line);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  if (!isSealedPayloadLength(m[3].length)) return null;
  return { sm: Number(m[1]), sv: Number(m[2]), payload: m[3] };
}

/**
 * Longueur base64url (sans remplissage) compatible avec `nonce ‖ texte bourré chiffré ‖ étiquette` : 28 octets + un multiple
 * non nul de 4 Kio (section 1.2). Toute autre longueur est une corruption, refusée avant le décodage.
 */
export function isSealedPayloadLength(chars: number): boolean {
  if (!Number.isSafeInteger(chars) || chars <= 0 || chars % 4 === 1) return false;
  const bytes = Math.floor((chars * 3) / 4);
  const padded = bytes - NONCE_BYTES - TAG_BYTES;
  return padded >= PADDING_BLOCK_BYTES && padded % PADDING_BLOCK_BYTES === 0 && padded <= MAX_PADDED_PLAINTEXT_BYTES;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Codes d'erreur des commandes `sync_*` (section 11.1)
// ---------------------------------------------------------------------------------------------------------------------------------

export const SYNC_ERROR_CODES = [
  'not-configured',
  'folder-unreachable',
  'unsafe-folder',
  'not-local',
  'folder-too-large',
  'cloud-pending',
  'cloud-provider-stopped',
  'cloud-error',
  'vault-unavailable',
  'key-missing',
  'key-exists',
  'key-mismatch',
  'key-exhausted',
  'consent-denied',
  'rate-limited',
  'not-foreground',
  'already-open',
  'decrypt-failed',
  'truncated',
  'bad-name',
  'bad-header',
  'too-large',
  'newer-format',
  'rollback',
  'segment-mismatch',
  'segment-full',
  'state-mismatch',
  'folder-has-data',
  'wrong-window',
  'wrong-mode',
  'hlc-order',
  'invalid-pairing',
  'pairing-expired',
  'not-bound',
  'already-bound',
  'current-epoch',
  'io',
] as const;

export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export function isSyncErrorCode(value: unknown): value is SyncErrorCode {
  return typeof value === 'string' && (SYNC_ERROR_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Appairage (sections 2, 10.3)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Préfixe du texte du QR : `CTPAIR1.<base64url(JSON { v:1, k, d, e, x })>`. */
export const PAIRING_QR_PREFIX = 'CTPAIR1.';
/** Préfixe de la clé de secours imprimable (base32 Crockford, groupes de 5). */
export const RECOVERY_KEY_PREFIX = 'CT1-';

// ---------------------------------------------------------------------------------------------------------------------------------
// État publié (section 1.4) et accusés
// ---------------------------------------------------------------------------------------------------------------------------------

export type SyncDevicePlatform = 'windows' | 'ios';

/** Position dans le journal d'un appareil : `record` = nombre d'enregistrements déjà lus (ou publiés) du segment. */
export interface RecordCursor {
  readonly segment: number;
  readonly record: number;
}

/** Accusé de lecture (ou tête publiée) : époque, position, plus grand hlc, `stateSeq` de l'état lu (second audit, point 4). */
export interface DeviceAck extends RecordCursor {
  readonly epoch: EpochId;
  readonly hlc: Hlc | null;
  readonly stateSeq: number;
}

/** Réservé (Y-11) : toujours null jusqu'au lot Y4. */
export interface ResetNotice {
  readonly kid: string;
  readonly epoch: EpochId;
  readonly at: Hlc;
}

/** Réservé (Y-10) : liste toujours vide jusqu'au lot Y4. */
export interface ForgottenDevice {
  readonly deviceId: DeviceId;
  readonly at: Hlc;
  readonly lastAck: DeviceAck | null;
}

/** Texte clair de l'unique enregistrement de `state.ctx`. */
export interface PublishedDeviceState {
  readonly deviceId: DeviceId;
  readonly platform: SyncDevicePlatform;
  readonly appVersion: string;
  readonly sm: number;
  readonly sv: number;
  readonly epoch: EpochId;
  /** Strictement croissant à chaque réécriture (section 1.4). */
  readonly stateSeq: number;
  readonly head: DeviceAck;
  /** 64 au plus. */
  readonly acks: ReadonlyMap<DeviceId, DeviceAck>;
  readonly snapshot: { readonly seq: number; readonly endHlc: Hlc } | null;
  readonly purgeHorizon: Hlc | null;
  readonly lastSyncHlc: Hlc;
  readonly pairedBy?: DeviceId;
  /** Toujours [] jusqu'au lot Y4 ; 64 au plus ; maître : Rust. */
  readonly forgotten: readonly ForgottenDevice[];
  /** Toujours null jusqu'au lot Y4 ; maître : Rust. */
  readonly reset: ResetNotice | null;
}

/**
 * Forme JSON de `PublishedDeviceState` (texte clair chiffré dans `state.ctx`, et forme qui passe par l'IPC) : `acks` est un objet
 * indexé par `device_id`, `pairedBy` est absent s'il n'est pas connu.
 */
export interface PublishedDeviceStateJson extends Omit<PublishedDeviceState, 'acks'> {
  readonly acks: Readonly<Record<string, DeviceAck>>;
}

const ackToJson = (a: DeviceAck): DeviceAck => ({ epoch: a.epoch, segment: a.segment, record: a.record, hlc: a.hlc, stateSeq: a.stateSeq });

/**
 * Sérialise l'état publié sous forme canonique : clés dans un ordre fixe à tous les niveaux, accusés triés par `device_id`. Le même
 * état donne toujours le même texte (condensé stable de l'anti-rejeu), quel que soit l'ordre des clés de l'objet reçu.
 */
export function publishedStateToJson(state: PublishedDeviceState): PublishedDeviceStateJson {
  const acks: Record<string, DeviceAck> = Object.create(null) as Record<string, DeviceAck>;
  for (const id of [...state.acks.keys()].sort()) {
    const ack = state.acks.get(id);
    if (ack) acks[id] = ackToJson(ack);
  }
  const json: PublishedDeviceStateJson = {
    deviceId: state.deviceId,
    platform: state.platform,
    appVersion: state.appVersion,
    sm: state.sm,
    sv: state.sv,
    epoch: state.epoch,
    stateSeq: state.stateSeq,
    head: ackToJson(state.head),
    acks,
    snapshot: state.snapshot === null ? null : { seq: state.snapshot.seq, endHlc: state.snapshot.endHlc },
    purgeHorizon: state.purgeHorizon,
    lastSyncHlc: state.lastSyncHlc,
    forgotten: state.forgotten.map((f) => ({ deviceId: f.deviceId, at: f.at, lastAck: f.lastAck === null ? null : ackToJson(f.lastAck) })),
    reset: state.reset === null ? null : { kid: state.reset.kid, epoch: state.reset.epoch, at: state.reset.at },
  };
  return state.pairedBy === undefined ? json : { ...json, pairedBy: state.pairedBy };
}

const ACK_KEYS = ['epoch', 'hlc', 'record', 'segment', 'stateSeq'] as const;

/** Validation stricte d'un accusé : exactement ses cinq clés, types, noms, hlc strict. */
export function isDeviceAck(value: unknown): value is DeviceAck {
  if (!hasExactKeys(value, ACK_KEYS)) return false;
  const a = value as Record<string, unknown>;
  return (
    isEpochId(a['epoch']) &&
    isCount(a['segment']) &&
    isCount(a['record']) &&
    (a['hlc'] === null || isStrictHlc(a['hlc'])) &&
    isCount(a['stateSeq'])
  );
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositive(value: unknown): value is number {
  return isCount(value) && value >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Objet dont les clés propres sont exactement `required`, plus éventuellement `optional` (clé interdite : refus). */
function hasExactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => FORBIDDEN_KEYS.has(key) || (!required.includes(key) && !optional.includes(key)))) return false;
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** Version de l'app publiée (texte court, sans espace). */
const APP_VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;

const STATE_KEYS = [
  'deviceId',
  'platform',
  'appVersion',
  'sm',
  'sv',
  'epoch',
  'stateSeq',
  'head',
  'acks',
  'snapshot',
  'purgeHorizon',
  'lastSyncHlc',
  'forgotten',
  'reset',
] as const;

function isForgottenDevice(value: unknown): value is ForgottenDevice {
  if (!hasExactKeys(value, ['deviceId', 'at', 'lastAck'])) return false;
  return isSyncDeviceId(value['deviceId']) && isStrictHlc(value['at']) && (value['lastAck'] === null || isDeviceAck(value['lastAck']));
}

function isResetNotice(value: unknown): value is ResetNotice {
  if (!hasExactKeys(value, ['kid', 'epoch', 'at'])) return false;
  return isKid(value['kid']) && isEpochId(value['epoch']) && isStrictHlc(value['at']);
}

/**
 * Analyse stricte de la forme JSON d'un état publié (section 1.4) : clés exactes (`pairedBy` facultative), types, noms et hlc
 * stricts, au plus 64 accusés et 64 appareils oubliés, tête dans l'époque annoncée et `head.stateSeq` = `stateSeq`. Renvoie null
 * sinon (`corrupt`). Les règles propres à Rust (`forgotten` vide, `reset` nul jusqu'au lot Y4) ne sont
 * pas contrôlées ici : un état d'une version plus récente peut les porter.
 */
export function publishedStateFromJson(value: unknown): PublishedDeviceState | null {
  if (!hasExactKeys(value, STATE_KEYS, ['pairedBy'])) return null;
  const s = value;
  if (!isSyncDeviceId(s['deviceId']) || (s['platform'] !== 'windows' && s['platform'] !== 'ios')) return null;
  if (typeof s['appVersion'] !== 'string' || !APP_VERSION_RE.test(s['appVersion'])) return null;
  if (!isPositive(s['sm']) || !isPositive(s['sv']) || !isEpochId(s['epoch']) || !isPositive(s['stateSeq'])) return null;
  const head = s['head'];
  if (!isDeviceAck(head) || head.epoch !== s['epoch'] || head.stateSeq !== s['stateSeq']) return null;
  const rawAcks = s['acks'];
  if (!isPlainObject(rawAcks)) return null;
  const ackIds = Object.keys(rawAcks);
  if (ackIds.length > MAX_STATE_ACKS) return null;
  const acks = new Map<DeviceId, DeviceAck>();
  for (const id of ackIds.sort()) {
    const ack = rawAcks[id];
    if (!isSyncDeviceId(id) || !isDeviceAck(ack)) return null;
    acks.set(id, ack);
  }
  const snapshot = s['snapshot'];
  if (snapshot !== null && !(hasExactKeys(snapshot, ['seq', 'endHlc']) && isFileNumber(snapshot['seq']) && isStrictHlc(snapshot['endHlc']))) {
    return null;
  }
  if (s['purgeHorizon'] !== null && !isStrictHlc(s['purgeHorizon'])) return null;
  if (!isStrictHlc(s['lastSyncHlc'])) return null;
  if ('pairedBy' in s && !isSyncDeviceId(s['pairedBy'])) return null;
  const forgotten = s['forgotten'];
  if (!Array.isArray(forgotten) || forgotten.length > MAX_STATE_FORGOTTEN || !forgotten.every(isForgottenDevice)) return null;
  if (s['reset'] !== null && !isResetNotice(s['reset'])) return null;
  const state: PublishedDeviceState = {
    deviceId: s['deviceId'],
    platform: s['platform'],
    appVersion: s['appVersion'],
    sm: s['sm'],
    sv: s['sv'],
    epoch: s['epoch'],
    stateSeq: s['stateSeq'],
    head,
    acks,
    snapshot: snapshot === null ? null : { seq: snapshot['seq'] as number, endHlc: snapshot['endHlc'] as Hlc },
    purgeHorizon: s['purgeHorizon'],
    lastSyncHlc: s['lastSyncHlc'],
    forgotten: forgotten as readonly ForgottenDevice[],
    reset: s['reset'] as ResetNotice | null,
  };
  return 'pairedBy' in s ? { ...state, pairedBy: s['pairedBy'] as DeviceId } : state;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Enregistrements de journal (section 3.1) et d'instantané (section 5.1), forme après analyse
// ---------------------------------------------------------------------------------------------------------------------------------

/** Valeur d'une colonne publiée (même domaine que `SqlValue` du pilote : booléens en 0 / 1, JSON en texte). */
export type SyncValue = string | number | null;

/** `[valeur, hlc de la valeur, hlc de la valeur remplacée (base) ou null si inconnue]`. */
export type SyncField = readonly [value: SyncValue, hlc: Hlc, base: Hlc | null];

/** Nom de champ « toutes les colonnes publiées » (file d'envoi, horloges de champ). */
export const ALL_FIELDS = '*';

export interface SyncOp {
  /** Table ; résolue par le catalogue seulement (section 3.3). */
  readonly t: string;
  /** Identifiant de la ligne ; pour `settings`, la clé du réglage. */
  readonly id: string;
  /** `updated_at` de l'écriture la plus récente de l'opération. */
  readonly at: IsoDateTime;
  /** Map après analyse, jamais un objet ordinaire (audit H5). */
  readonly f: ReadonlyMap<string, SyncField>;
}

export interface JournalRecord {
  readonly k: 'ops';
  /** `schema_version` de l'écrivain, vérifié égal au `sv` de la ligne. */
  readonly sv: number;
  /** Ordre de publication : hlc croissant, parents avant enfants (section 3.3). */
  readonly ops: readonly SyncOp[];
}

/** Horloges de champ d'une ligne d'instantané : entrée `'*'` obligatoire, puis les exceptions (champ → hlc). */
export type SnapshotClocks = ReadonlyMap<string, Hlc>;

export type SnapshotRow = readonly [table: string, row: ReadonlyMap<string, SyncValue>, clocks: SnapshotClocks];

export interface SnapshotUnknownField {
  readonly t: string;
  readonly id: string;
  readonly field: string;
  readonly value: SyncValue;
  readonly hlc: Hlc;
  readonly base: Hlc | null;
  readonly sv: number;
}

export type SnapshotRecord =
  | { readonly k: 'snap-rows'; readonly rows: readonly SnapshotRow[] }
  | { readonly k: 'snap-row'; readonly t: string; readonly row: ReadonlyMap<string, SyncValue>; readonly clocks: SnapshotClocks }
  | { readonly k: 'snap-unknown'; readonly fields: readonly SnapshotUnknownField[] }
  | { readonly k: 'snap-tombstones'; readonly ids: readonly (readonly [table: string, id: string, deletedHlc: Hlc])[] }
  | {
      readonly k: 'snap-end';
      readonly count: number;
      /** Position, par appareil, jusqu'à laquelle les journaux sont inclus (section 5.1). */
      readonly covers: ReadonlyMap<DeviceId, DeviceAck>;
      readonly epoch: EpochId;
      readonly sv: number;
    };

/** Clés interdites à tout niveau du texte clair analysé (audit H5) : l'enregistrement entier est refusé. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Nom de table ou de champ inconnu admis dans `sync_unknown` (section 7.2). */
const UNKNOWN_NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
/** Clé de réglage inconnue admise (section 8, audit M5). */
const UNKNOWN_SETTING_KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){1,3}$/;

export function isUnknownName(value: string): boolean {
  return UNKNOWN_NAME_RE.test(value) && !FORBIDDEN_KEYS.has(value);
}

export function isUnknownSettingKey(value: string): boolean {
  return UNKNOWN_SETTING_KEY_RE.test(value) && !value.split('.').some((part) => FORBIDDEN_KEYS.has(part));
}

/** Ordre topologique des tables publiées (section 3.3) : départage des opérations de même hlc. */
export const SYNC_TABLE_ORDER = [
  'space',
  'project',
  'recurrence',
  'goal',
  'task',
  'routine',
  'routine_log',
  'routine_pause',
  'reminder',
  'event',
  'checklist',
  'checklist_item',
  'focus_session',
  'calendar_account',
  'holiday',
  'settings',
] as const;
