import type { DeviceId, Hlc } from '../../domain/types';
import {
  CONSENT_BLOCK_MS,
  CONSENT_MAX_IMPORT,
  CONSENT_MAX_SHOW,
  CONSENT_WINDOW_MS,
  FOLDER_STOP_BYTES,
  MAX_APPEND_CALL_BYTES,
  MAX_DEVICE_FOLDERS,
  MAX_IPC_PAGE_BYTES,
  MAX_RECORD_PLAINTEXT_BYTES,
  MAX_SCAN_ENTRIES_PER_FOLDER,
  MAX_SEGMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_STATE_ACKS,
  MAX_STATE_FILE_BYTES,
  MAX_STATE_FORGOTTEN,
  NONCE_MAX_RECORDS,
  PAIRING_CLOCK_TOLERANCE_MS,
  PAIRING_QR_PREFIX,
  PAIRING_VALIDITY_MS,
  RECOVERY_KEY_PREFIX,
  SEGMENT_ROTATE_BYTES,
  STATE_FILE,
  SYNC_FORMAT_MAJOR,
  compareEpochs,
  encryptedLineBytes,
  isEpochId,
  isFileNumber,
  isStrictHlc,
  isSyncDeviceId,
  hasStrictJsonShape,
  parseSyncFileName,
  publishedStateFromJson,
  publishedStateToJson,
  segmentFileName,
  snapshotFileName,
  utf8Bytes,
  type DeviceAck,
  type EpochId,
  type FileHeader,
  type PublishedDeviceState,
  type RecordCursor,
  type SyncDevicePlatform,
} from '../../domain/sync/format';
import {
  SyncPlatformError,
  type AppendJournalRequest,
  type AppendJournalResult,
  type DeviceScan,
  type DeviceStateStatus,
  type EpochListing,
  type FileAvailability,
  type FolderScan,
  type KeyImportInput,
  type KeyImportResult,
  type OwnFileRef,
  type PairingMode,
  type PairingPayload,
  type ReadJournalRequest,
  type ReadPage,
  type ReadSnapshotRequest,
  type ScanRequest,
  type RestoreMarker,
  type SyncErrorCode,
  type SyncFolderInfo,
  type SyncPlatform,
} from './types';
import { parsePublishedStateText } from '../../domain/sync/parse';

/**
 * Implémentation mémoire de `SyncPlatform` (ADR 0011, section 0 ; Y-01, Y-02, Y-06, Y-08) pour Vitest, Playwright et le navigateur de
 * dev. Elle tient le rôle du côté Rust : dossier choisi, coffre, `own.json`, fichiers par appareil et par époque, appairage et
 * confirmations natives, bornes de la section 1.6, avec les mêmes codes d'erreur. Jamais utilisée dans l'app installée.
 *
 * Différences assumées avec Rust : aucun chiffrement (les enregistrements sont gardés en texte clair ; la taille sur disque est
 * calculée par `encryptedLineBytes`, bourrage compris) ; le `kid` est dérivé comme en Rust (HKDF-SHA256, Web Crypto) ; le codec de
 * référence et les vecteurs croisés arrivent avec les lots Y1 et Y2 (`tests/sim/syncCodec.ts`). Plusieurs plateformes peuvent
 * partager un même `MemorySyncFolder` (un « iCloud » qui propage tout immédiatement ; les retards se simulent par les crochets).
 */

// ---------------------------------------------------------------------------------------------------------------------------------
// Dossier partagé
// ---------------------------------------------------------------------------------------------------------------------------------

interface MemLine {
  readonly sm: number;
  readonly sv: number;
  readonly text: string;
  /** Taille sur disque de la ligne chiffrée, `\n` compris. */
  readonly bytes: number;
  /** Échec de déchiffrement simulé (crochet `corruptRecord`). */
  corrupt: boolean;
}

interface MemFile {
  readonly header: FileHeader;
  readonly lines: MemLine[];
  /** Dernière ligne incomplète (iCloud en cours de transfert) : jamais lue. */
  partialTail: boolean;
  availability: FileAvailability;
  /** Octets ajoutés à la taille annoncée (crochet `addBytes`). */
  extraBytes: number;
}

interface EpochDir {
  readonly segments: Map<number, MemFile>;
  readonly snapshots: Map<number, MemFile>;
}

interface DeviceDir {
  state: MemFile | null;
  readonly epochs: Map<EpochId, EpochDir>;
  /** Entrées au nom non strict (copies de conflit, `*.tmp`, fichiers étrangers) : ignorées, comptées. */
  strays: number;
}

/** Copie opaque d'un `state.ctx` (crochets `takeState` / `putState` : rejeu d'un ancien état). */
export interface StateFileCopy {
  readonly deviceId: string;
  readonly file: MemFile | null;
}

/** Taille arbitraire d'une ligne incomplète simulée. */
const PARTIAL_TAIL_BYTES = 100;

const cloneFile = (file: MemFile): MemFile => ({ ...file, lines: file.lines.map((line) => ({ ...line })) });

/**
 * Dossier `iCloud Drive/CircleTasks` simulé. Les méthodes publiques autres que le constructeur sont des **crochets de test** : elles
 * modifient le dossier comme le ferait iCloud ou un tiers (fichier dans le nuage, ligne incomplète, corruption, copie de conflit).
 * `file` désigne `state.ctx` ou `<époque>/<nom strict>`.
 */
export class MemorySyncFolder {
  /** Contenu par dossier d'appareil (nom = `device_id`, ou nom quelconque posé par `addDeviceFolder`). */
  readonly devices = new Map<string, DeviceDir>();
  /** Entrées non strictes à la racine de `devices/`. */
  rootStrays = 0;
  /** Octets ajoutés à la taille totale (crochet `padFolder`). */
  extraBytes = 0;

  constructor(
    readonly id: string = 'memory-folder',
    /** Faux de dev et de test : jamais affiché tel quel, l'écran tire ses textes de src/i18n (le libellé réel vient de Rust). */
    readonly label: string = 'iCloud Drive / CircleTasks',
    readonly kind: SyncFolderInfo['kind'] = 'icloud',
  ) {}

  /** Dossier d'appareil vide (nom quelconque : un nom non UUID est ignoré par `scan`). */
  addDeviceFolder(name: string): void {
    if (!this.devices.has(name)) this.devices.set(name, { state: null, epochs: new Map(), strays: 0 });
  }

  addStrayEntries(deviceId: string | null, count: number): void {
    if (deviceId === null) {
      this.rootStrays += count;
      return;
    }
    this.addDeviceFolder(deviceId);
    const dir = this.devices.get(deviceId);
    if (dir) dir.strays += count;
  }

  setAvailability(deviceId: string, file: string, availability: FileAvailability): void {
    this.mustFind(deviceId, file).availability = availability;
  }

  setPartialTail(deviceId: string, file: string, partial: boolean): void {
    this.mustFind(deviceId, file).partialTail = partial;
  }

  corruptRecord(deviceId: string, file: string, index: number): void {
    const line = this.mustFind(deviceId, file).lines[index];
    if (!line) throw new RangeError('enregistrement absent');
    line.corrupt = true;
  }

  addBytes(deviceId: string, file: string, bytes: number): void {
    this.mustFind(deviceId, file).extraBytes += bytes;
  }

  padFolder(bytes: number): void {
    this.extraBytes += bytes;
  }

  /** Supprime un fichier (tiers, ou fichier pas encore arrivé). */
  removeFile(deviceId: string, file: string): void {
    const dir = this.devices.get(deviceId);
    if (!dir) return;
    if (file === STATE_FILE) {
      dir.state = null;
      return;
    }
    const where = splitFile(file);
    const epochDir = where ? dir.epochs.get(where.epoch) : undefined;
    if (!where || !epochDir) return;
    (where.kind === 'segment' ? epochDir.segments : epochDir.snapshots).delete(where.n);
  }

  takeState(deviceId: string): StateFileCopy {
    const state = this.devices.get(deviceId)?.state ?? null;
    return { deviceId, file: state ? cloneFile(state) : null };
  }

  putState(copy: StateFileCopy): void {
    this.addDeviceFolder(copy.deviceId);
    const dir = this.devices.get(copy.deviceId);
    if (dir) dir.state = copy.file ? cloneFile(copy.file) : null;
  }

  /** Noms stricts présents dans un dossier d'appareil (`state.ctx`, `<époque>/<fichier>`), triés. */
  fileNames(deviceId: string): string[] {
    const dir = this.devices.get(deviceId);
    if (!dir) return [];
    const names: string[] = dir.state ? [STATE_FILE] : [];
    for (const [epoch, epochDir] of dir.epochs) {
      for (const n of epochDir.segments.keys()) names.push(`${epoch}/${segmentFileName(n)}`);
      for (const n of epochDir.snapshots.keys()) names.push(`${epoch}/${snapshotFileName(n)}`);
    }
    return names.sort();
  }

  /** Lignes complètes d'un fichier, en texte clair (tests : vérifier ce qui a été écrit). */
  records(deviceId: string, file: string): string[] {
    return this.mustFind(deviceId, file).lines.map((line) => line.text);
  }

  private mustFind(deviceId: string, file: string): MemFile {
    const dir = this.devices.get(deviceId);
    const found = dir ? findFile(dir, file) : null;
    if (!found) throw new RangeError('fichier absent du dossier simulé');
    return found;
  }
}

function splitFile(file: string): { readonly epoch: EpochId; readonly kind: 'segment' | 'snapshot'; readonly n: number } | null {
  const slash = file.indexOf('/');
  if (slash < 0) return null;
  const epoch = file.slice(0, slash);
  const name = parseSyncFileName(file.slice(slash + 1));
  if (!isEpochId(epoch) || !name || name.kind === 'state') return null;
  return { epoch, kind: name.kind, n: name.n };
}

function findFile(dir: DeviceDir, file: string): MemFile | null {
  if (file === STATE_FILE) return dir.state;
  const where = splitFile(file);
  const epochDir = where ? dir.epochs.get(where.epoch) : undefined;
  if (!where || !epochDir) return null;
  return (where.kind === 'segment' ? epochDir.segments : epochDir.snapshots).get(where.n) ?? null;
}

function headerBytes(header: FileHeader): number {
  return utf8Bytes(JSON.stringify(header)) + 1;
}

function fileBytes(file: MemFile): number {
  let total = headerBytes(file.header) + file.extraBytes + (file.partialTail ? PARTIAL_TAIL_BYTES : 0);
  for (const line of file.lines) total += line.bytes;
  return total;
}

function folderBytes(folder: MemorySyncFolder): number {
  let total = folder.extraBytes;
  for (const dir of folder.devices.values()) {
    if (dir.state) total += fileBytes(dir.state);
    for (const epochDir of dir.epochs.values()) {
      for (const file of epochDir.segments.values()) total += fileBytes(file);
      for (const file of epochDir.snapshots.values()) total += fileBytes(file);
    }
  }
  return total;
}

function makeLine(text: string, sm: number, sv: number): MemLine {
  return { sm, sv, text, bytes: encryptedLineBytes(utf8Bytes(text), sm, sv), corrupt: false };
}

const maxKey = (map: ReadonlyMap<number, unknown>): number => Math.max(0, ...map.keys());

// ---------------------------------------------------------------------------------------------------------------------------------
// Clé, kid, QR et clé de secours (section 2 ; équivalent de crypto.rs et pairing.rs)
// ---------------------------------------------------------------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

const toHex = (bytes: Bytes): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

function toBase64Url(bytes: Bytes): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** `kid = hex(HKDF-SHA256(K, sel "circletasks", info "ct/1 kid")[0..8])` (section 2). */
async function kidOf(key: Bytes): Promise<string> {
  const base = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('circletasks'), info: encoder.encode('ct/1 kid') },
    base,
    64,
  );
  return toHex(new Uint8Array(bits));
}

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_BYTES = 32;
const RECOVERY_BYTES = KEY_BYTES + 2;
const RECOVERY_CHARS = Math.ceil((RECOVERY_BYTES * 8) / 5); // 55

/** Clé de secours : `K ‖ SHA-256(K)[0..2]` en base32 Crockford, groupes de 5 caractères, préfixe `CT1-`. */
async function recoveryKeyOf(key: Bytes): Promise<string> {
  const digest = await sha256(key);
  const data = new Uint8Array(RECOVERY_BYTES);
  data.set(key, 0);
  data.set(digest.subarray(0, 2), KEY_BYTES);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >> (bits - 5)) & 31] ?? '';
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31] ?? '';
  return RECOVERY_KEY_PREFIX + (out.match(/.{1,5}/g) ?? []).join('-');
}

/** Décodage tolérant (casse, espaces, tirets, `O`/`0`, `I`/`L`/`1`) et contrôle de la somme ; null si invalide. */
async function keyFromRecovery(input: string): Promise<Bytes | null> {
  let text = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const prefix = RECOVERY_KEY_PREFIX.replace(/-/g, '');
  if (text.length === RECOVERY_CHARS + prefix.length && text.startsWith(prefix)) text = text.slice(prefix.length);
  if (text.length !== RECOVERY_CHARS) return null;
  const data = new Uint8Array(RECOVERY_BYTES);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    const digit = CROCKFORD.indexOf(char);
    if (digit < 0) return null;
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      if (index < RECOVERY_BYTES) data[index] = (value >> (bits - 8)) & 0xff;
      index += 1;
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  if (value !== 0) return null; // bits de remplissage non nuls
  const key = data.slice(0, KEY_BYTES);
  const digest = await sha256(key);
  return digest[0] === data[KEY_BYTES] && digest[1] === data[KEY_BYTES + 1] ? key : null;
}

interface QrContent {
  readonly key: Bytes;
  readonly deviceId: DeviceId;
  readonly epoch: EpochId | null;
  readonly expiresAt: number;
}

function qrTextOf(content: QrContent): string {
  const json = JSON.stringify({ v: 1, k: toBase64Url(content.key), d: content.deviceId, e: content.epoch, x: content.expiresAt });
  return PAIRING_QR_PREFIX + toBase64Url(encoder.encode(json));
}

/** Analyse stricte du texte du QR : `CTPAIR1.<base64url(JSON { v:1, k, d, e, x })>`, clés exactes. */
function parseQrText(text: string): QrContent | null {
  if (!text.startsWith(PAIRING_QR_PREFIX) || text.length > 1024) return null;
  const bytes = fromBase64Url(text.slice(PAIRING_QR_PREFIX.length));
  if (!bytes) return null;
  let value: unknown;
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'd,e,k,v,x') return null;
  // Comme serde : clé répétée refusée, `v` et `x` entiers canoniques non signés (ni `1.0`, ni `1e0`, ni négatifs).
  if (!hasStrictJsonShape(json, 5)) return null;
  const q = value as Record<string, unknown>;
  if (q['v'] !== 1 || typeof q['k'] !== 'string' || !isSyncDeviceId(q['d'])) return null;
  if (q['e'] !== null && !isEpochId(q['e'])) return null;
  if (typeof q['x'] !== 'number' || !Number.isSafeInteger(q['x']) || q['x'] < 0) return null;
  const key = fromBase64Url(q['k']);
  if (!key || key.length !== KEY_BYTES) return null;
  return { key, deviceId: q['d'], epoch: q['e'], expiresAt: q['x'] };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Plateforme
// ---------------------------------------------------------------------------------------------------------------------------------

export interface MemorySyncOptions {
  /** Dossier rendu par le premier `folder.choose()` (par défaut, un dossier neuf). */
  readonly folder?: MemorySyncFolder;
  /** `windows` (fenêtre dédiée `pairing`) ou `ios` (import depuis `main`, scan du QR ; ordre 5). */
  readonly platform?: SyncDevicePlatform;
  readonly available?: boolean;
  /** Horloge physique injectable (ms Unix). */
  readonly nowMs?: () => number;
}

/** `own.json` (section 1.4) : tête de ses propres ajouts, maître des contrôles de `sync_write_state`. */
interface OwnState {
  readonly folderId: string;
  readonly kid: string;
  epoch: EpochId | null;
  segment: number;
  record: number;
  maxHlc: Hlc | null;
  stateSeq: number;
  pairedBy: DeviceId | null;
}

interface PairingInstance {
  readonly mode: PairingMode;
  generation: number;
  openedAt: number;
  /** Jeton à usage unique de la génération courante déjà consommé. */
  payloadTaken: boolean;
}

interface AcceptedState {
  readonly epoch: EpochId;
  readonly seq: number;
  readonly digest: string;
  readonly head: RecordCursor;
}

export interface MemorySyncTesting {
  /** Réponse des prochaines confirmations natives (vrai : l'utilisateur accepte). */
  setConsent(answer: boolean): void;
  /** Fenêtre visible et au premier plan (préconditions des confirmations). */
  setForeground(foreground: boolean): void;
  /** Résultat du prochain `folder.choose()` : un dossier, ou null (choix annulé). */
  setChooser(next: MemorySyncFolder | null): void;
  setVaultAvailable(available: boolean): void;
  setRestoreMarker(marker: RestoreMarker | null): void;
  /** iPhone : texte lu par le prochain scan du QR (null : scan annulé). */
  setScanResult(text: string | null): void;
  /** Instance `pairing` ouverte (mode, génération), ou null. */
  pairing(): { readonly mode: PairingMode; readonly generation: number } | null;
  /** Nombre de confirmations natives affichées. */
  consentPrompts(): number;
  /** Enregistrements scellés avec la clé (budget de nonces). */
  sealedRecords(): number;
  setSealedRecords(count: number): void;
  /** Simule la perte de `own.json` (dossier de configuration effacé). */
  dropOwnState(): void;
}

export interface MemorySyncPlatform extends SyncPlatform {
  readonly testing: MemorySyncTesting;
}

function fail(code: SyncErrorCode): never {
  throw new SyncPlatformError(code);
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isPositive = (value: unknown): value is number => isCount(value) && value >= 1;

const compareCursor = (a: RecordCursor, b: RecordCursor): number => (a.segment !== b.segment ? a.segment - b.segment : a.record - b.record);

export function createMemorySyncPlatform(options: MemorySyncOptions = {}): MemorySyncPlatform {
  const now = options.nowMs ?? (() => Date.now());
  const devicePlatform: SyncDevicePlatform = options.platform ?? 'windows';
  let chooserNext: MemorySyncFolder | null = options.folder ?? new MemorySyncFolder();

  let folder: MemorySyncFolder | null = null;
  let key: { readonly raw: Bytes; readonly kid: string } | null = null;
  let vaultAvailable = true;
  let bound: DeviceId | null = null;
  let own: OwnState | null = null;
  let marker: RestoreMarker | null = null;
  let sealed = 0;

  let consentAnswer = true;
  let foreground = true;
  let prompts = 0;
  let showOpenings: number[] = [];
  let importCalls: number[] = [];
  let blockedUntil = 0;
  let pairing: PairingInstance | null = null;
  let scanResult: string | null = null;
  /** `pairedBy` mémorisé à l'import quand l'appareil n'est pas encore lié (reporté dans `own.json` à la liaison). */
  let pendingPairedBy: DeviceId | null = null;

  /** Dernier état accepté par appareil (anti-rejeu, section 1.4). */
  const accepted = new Map<string, AcceptedState>();

  // --- préconditions ------------------------------------------------------------------------------------------------------------

  const requireFolder = (): MemorySyncFolder => folder ?? fail('not-configured');

  const requireVault = (): void => {
    if (!vaultAvailable) fail('vault-unavailable');
  };

  const requireKey = (): { readonly raw: Bytes; readonly kid: string } => {
    requireVault();
    return key ?? fail('key-missing');
  };

  const requireBound = (): DeviceId => bound ?? fail('not-bound');

  const requireReadable = (): { readonly folder: MemorySyncFolder; readonly kid: string } => {
    const f = requireFolder();
    const k = requireKey();
    if (folderBytes(f) > FOLDER_STOP_BYTES) fail('folder-too-large');
    return { folder: f, kid: k.kid };
  };

  /** Dossier, clé, appareil lié et `own.json` valide (reconstruit s'il manque ou ne correspond plus, section 1.4). */
  const requireWritable = (): { readonly folder: MemorySyncFolder; readonly kid: string; readonly self: DeviceId; readonly own: OwnState } => {
    const f = requireFolder();
    const k = requireKey();
    const self = requireBound();
    if (!own || own.folderId !== f.id || own.kid !== k.kid) own = rebuildOwn(f, k.kid, self);
    return { folder: f, kid: k.kid, self, own };
  };

  /**
   * Reconstruction de `own.json` (règle 1 de l'ADR 0010, section 9) depuis trois sources : son propre `state.ctx` authentifié, les
   * accusés `acks[self]` publiés par les autres appareils et la liste de ses fichiers. L'époque courante est la plus grande des trois ;
   * dans cette époque, la tête (segment, enregistrement) et le plus grand hlc sont les maxima des sources ; `stateSeq` est le maximum
   * sur toute la vie de l'appareil, toutes époques confondues. Rust ne lit pas le texte clair qu'il chiffre : les fichiers ne donnent
   * aucun hlc, mais un accusé suffit à garder le contrôle `hlc-order`. Une tête plus loin que les fichiers (segment tronqué ou
   * supprimé) ne bloque rien : le moteur reçoit `segment-mismatch` et ouvre le segment `max + 1`.
   */
  const rebuildOwn = (f: MemorySyncFolder, kid: string, self: DeviceId): OwnState => {
    const dir = f.devices.get(self);
    const mine = dir ? readState(self, dir, kid, false) : null;
    const state = mine?.status === 'ok' ? mine.state : null;
    const acks: DeviceAck[] = [];
    for (const [id, other] of f.devices) {
      if (id === self) continue;
      const read = readState(id, other, kid, false);
      const ack = read.status === 'ok' ? read.state?.acks.get(self) : undefined;
      if (ack) acks.push(ack);
    }
    const epochs: EpochId[] = [...(state ? [state.epoch] : []), ...(dir?.epochs.keys() ?? []), ...acks.map((a) => a.epoch)];
    const epoch = epochs.reduce<EpochId | null>((best, e) => (best === null || compareEpochs(e, best) > 0 ? e : best), null);
    const stateSeq = Math.max(state?.stateSeq ?? 0, ...acks.map((a) => a.stateSeq));
    const epochDir = epoch !== null ? dir?.epochs.get(epoch) : undefined;
    const listed = epochDir ? maxKey(epochDir.segments) : 0;
    const sources: { readonly cursor: RecordCursor; readonly hlc: Hlc | null }[] = [
      { cursor: { segment: listed, record: epochDir?.segments.get(listed)?.lines.length ?? 0 }, hlc: null },
      ...(state && state.epoch === epoch ? [{ cursor: state.head, hlc: state.head.hlc }] : []),
      ...acks.filter((a) => a.epoch === epoch).map((a) => ({ cursor: a, hlc: a.hlc })),
    ];
    let head: RecordCursor = { segment: 0, record: 0 };
    let maxHlc: Hlc | null = null;
    for (const source of sources) {
      if (compareCursor(source.cursor, head) > 0) head = { segment: source.cursor.segment, record: source.cursor.record };
      if (source.hlc !== null && (maxHlc === null || source.hlc > maxHlc)) maxHlc = source.hlc;
    }
    return { folderId: f.id, kid, epoch, segment: head.segment, record: head.record, maxHlc, stateSeq, pairedBy: state?.pairedBy ?? null };
  };

  // --- confirmations natives (consent.rs) ---------------------------------------------------------------------------------------

  const prune = (list: number[]): number[] => list.filter((at) => now() - at < CONSENT_WINDOW_MS);

  const gate = (): void => {
    if (!foreground) fail('consent-denied');
    if (now() < blockedUntil) fail('rate-limited');
  };

  /** Boîte de confirmation : toute ouverture compte, un refus bloque 10 minutes. */
  const askConsent = (): void => {
    prompts += 1;
    if (!consentAnswer) {
      blockedUntil = now() + CONSENT_BLOCK_MS;
      fail('consent-denied');
    }
  };

  const openShowConsent = (): void => {
    gate();
    showOpenings = prune(showOpenings);
    if (showOpenings.length >= CONSENT_MAX_SHOW) fail('rate-limited');
    showOpenings.push(now());
    askConsent();
  };

  /** Fenêtre `pairing` vivante (le minuteur de 5 minutes de la génération courante la détruit à l'échéance). */
  const livePairing = (): PairingInstance | null => {
    if (pairing && now() - pairing.openedAt >= PAIRING_VALIDITY_MS) pairing = null;
    return pairing;
  };

  // --- lecture d'un état publié -------------------------------------------------------------------------------------------------

  interface StateRead {
    readonly kid: string | null;
    readonly state: PublishedDeviceState | null;
    readonly status: DeviceStateStatus;
  }

  const anyKid = (dir: DeviceDir): string | null => {
    for (const epochDir of dir.epochs.values()) {
      for (const file of [...epochDir.segments.values(), ...epochDir.snapshots.values()]) {
        if (file.availability === 'local') return file.header.kid;
      }
    }
    return null;
  };

  /** Lecture d'un `state.ctx` : bornes, en-tête, clé, majeure, analyse stricte, anti-rejeu (`remember` : retenir l'état accepté). */
  const readState = (deviceId: string, dir: DeviceDir, localKid: string, remember: boolean): StateRead => {
    const file = dir.state;
    if (!file) return { kid: anyKid(dir), state: null, status: 'missing' };
    if (file.availability !== 'local') return { kid: anyKid(dir), state: null, status: 'cloud-pending' };
    if (fileBytes(file) > MAX_STATE_FILE_BYTES) return { kid: null, state: null, status: 'too-large' };
    const h = file.header;
    if (h.f !== 'ct-state' || h.dev !== deviceId || h.kid !== localKid) return { kid: h.kid, state: null, status: 'foreign' };
    if (h.sm > SYNC_FORMAT_MAJOR) return { kid: h.kid, state: null, status: 'newer-format' };
    // Ligne incomplète : iCloud est en train de livrer le fichier, il sera relu au cycle suivant (section 1.2).
    if (file.partialTail) return { kid: h.kid, state: null, status: 'cloud-pending' };
    const line = file.lines[0];
    if (!line || file.lines.length !== 1 || line.corrupt) return { kid: h.kid, state: null, status: 'corrupt' };
    // Analyse stricte du texte (parse.ts : clés répétées et nombres non entiers refusés comme serde, clés interdites).
    const state = parsePublishedStateText(line.text);
    if (!state || state.deviceId !== deviceId || state.epoch !== h.e || state.stateSeq !== h.n || state.sm !== line.sm || state.sv !== line.sv) {
      return { kid: h.kid, state: null, status: 'corrupt' };
    }
    const previous = accepted.get(deviceId);
    const current: AcceptedState = { epoch: state.epoch, seq: state.stateSeq, digest: line.text, head: state.head };
    if (previous && isRollback(previous, current)) return { kid: h.kid, state: null, status: 'rollback' };
    if (remember) accepted.set(deviceId, current);
    return { kid: h.kid, state, status: 'ok' };
  };

  /**
   * Anti-rejeu : époque qui recule ; `stateSeq` qui recule (il croît sur toute la vie de l'appareil, toutes époques confondues) ;
   * même `stateSeq` et autre contenu ; tête qui recule à époque égale (une nouvelle époque repart de 1).
   */
  const isRollback = (previous: AcceptedState, current: AcceptedState): boolean => {
    const byEpoch = compareEpochs(current.epoch, previous.epoch);
    if (byEpoch < 0 || current.seq < previous.seq) return true;
    if (current.seq === previous.seq) return current.digest !== previous.digest;
    return byEpoch === 0 && compareCursor(current.head, previous.head) < 0;
  };

  const errorOfStatus = (status: DeviceStateStatus): SyncErrorCode | null => {
    switch (status) {
      case 'ok':
      case 'missing':
      case 'cloud-pending':
        return null;
      case 'foreign':
        return 'key-mismatch';
      case 'corrupt':
        return 'decrypt-failed';
      case 'rollback':
        return 'rollback';
      case 'too-large':
        return 'too-large';
      case 'newer-format':
        return 'newer-format';
    }
  };

  /** Tête authentifiée d'un appareil pour une lecture ; null : rien de lisible pour l'instant (en attente d'iCloud). */
  const authenticatedState = (f: MemorySyncFolder, kid: string, deviceId: DeviceId): PublishedDeviceState | null => {
    const dir = f.devices.get(deviceId);
    if (!dir) return null;
    const read = readState(deviceId, dir, kid, true);
    const code = errorOfStatus(read.status);
    if (code) fail(code);
    return read.state;
  };

  // --- scan ---------------------------------------------------------------------------------------------------------------------

  const scanDevice = (deviceId: DeviceId, dir: DeviceDir, kid: string): { readonly scan: DeviceScan; readonly incomplete: boolean } => {
    const read = readState(deviceId, dir, kid, true);
    let incomplete = (dir.state ? 1 : 0) + dir.epochs.size + dir.strays > MAX_SCAN_ENTRIES_PER_FOLDER;
    const epochs: EpochListing[] = [];
    for (const epoch of [...dir.epochs.keys()].sort(compareEpochs)) {
      const epochDir = dir.epochs.get(epoch);
      if (!epochDir) continue;
      const segments = [...epochDir.segments.keys()].sort((a, b) => a - b);
      const snapshots = [...epochDir.snapshots.keys()].sort((a, b) => a - b);
      if (segments.length + snapshots.length > MAX_SCAN_ENTRIES_PER_FOLDER) incomplete = true;
      epochs.push({
        epoch,
        segments: segments.slice(0, MAX_SCAN_ENTRIES_PER_FOLDER),
        snapshots: snapshots.slice(0, Math.max(0, MAX_SCAN_ENTRIES_PER_FOLDER - segments.length)),
      });
    }
    // Fichiers attendus et pas encore lisibles : `state.ctx`, puis ce que la tête authentifiée annonce (jamais au-delà).
    const pending: { file: string; availability: FileAvailability }[] = [];
    if (dir.state && dir.state.availability !== 'local') pending.push({ file: STATE_FILE, availability: dir.state.availability });
    const state = read.state;
    const epochDir = state ? dir.epochs.get(state.epoch) : undefined;
    if (state && state.head.segment >= 1) {
      // Segments annoncés : du plus petit listé (les plus anciens ont pu être purgés) jusqu'à la tête. Un segment annoncé mais
      // absent n'est pas encore arrivé : listé comme resté dans le nuage.
      const listed = [...(epochDir?.segments.keys() ?? [])];
      const from = Math.min(state.head.segment, ...listed);
      for (let n = from; n <= state.head.segment; n += 1) {
        const file = epochDir?.segments.get(n);
        const availability: FileAvailability = file ? file.availability : 'cloud';
        if (availability !== 'local') pending.push({ file: `${state.epoch}/${segmentFileName(n)}`, availability });
      }
    }
    if (state && epochDir) {
      for (const [n, file] of [...epochDir.snapshots].sort(([a], [b]) => a - b)) {
        if (state.snapshot && n <= state.snapshot.seq && file.availability !== 'local') {
          pending.push({ file: `${state.epoch}/${snapshotFileName(n)}`, availability: file.availability });
        }
      }
    }
    return { scan: { deviceId, kid: read.kid, state, stateStatus: read.status, epochs, pending }, incomplete };
  };

  const scan = async (r: ScanRequest): Promise<FolderScan> => {
    const keepList: unknown = (r as Partial<ScanRequest> | undefined)?.keep;
    if (!Array.isArray(keepList) || !keepList.every((id) => isSyncDeviceId(id))) return fail('bad-name');
    const { folder: f, kid } = requireReadable();
    let ignored = f.rootStrays;
    let incomplete = f.devices.size + f.rootStrays > MAX_SCAN_ENTRIES_PER_FOLDER;
    const scans: DeviceScan[] = [];
    for (const [name, dir] of f.devices) {
      if (!isSyncDeviceId(name)) {
        ignored += 1;
        continue;
      }
      ignored += dir.strays;
      const result = scanDevice(name, dir, kid);
      if (result.incomplete) incomplete = true;
      scans.push(result.scan);
    }
    // Plafond de 16 dossiers : son propre dossier et ceux de `keep` (connus de `sync_state`) ne sont jamais écartés, même au-delà
    // de 16 ; parmi les autres, sont écartés d'abord ceux sans état valide, puis le plus ancien `lastSyncHlc` (section 1.1).
    const protectedIds = new Set<string>(keepList);
    if (bound !== null) protectedIds.add(bound);
    const selfScan = scans.filter((s) => protectedIds.has(s.deviceId));
    const others = scans
      .filter((s) => !protectedIds.has(s.deviceId))
      .sort((a, b) => {
        const ha = a.state?.lastSyncHlc ?? '';
        const hb = b.state?.lastSyncHlc ?? '';
        return ha < hb ? 1 : ha > hb ? -1 : a.deviceId < b.deviceId ? -1 : 1;
      });
    const room = Math.max(0, MAX_DEVICE_FOLDERS - selfScan.length);
    const kept = [...selfScan, ...others.slice(0, room)];
    const dropped = Math.max(0, others.length - room);
    return {
      devices: kept.sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
      ignored: ignored + dropped,
      totalBytes: folderBytes(f),
      tooManyDevices: dropped > 0,
      incomplete,
    };
  };

  // --- lecture des journaux et instantanés --------------------------------------------------------------------------------------

  const pageLimit = (maxBytes: number | undefined): number => {
    if (maxBytes === undefined) return MAX_IPC_PAGE_BYTES;
    if (!isPositive(maxBytes)) fail('bad-name');
    return Math.min(maxBytes, MAX_IPC_PAGE_BYTES);
  };

  const checkFileForRead = (file: MemFile, kid: string, limit: number): void => {
    if (fileBytes(file) > limit) fail('too-large');
    if (file.header.kid !== kid) fail('key-mismatch');
    if (file.header.sm > SYNC_FORMAT_MAJOR) fail('newer-format');
  };

  const readJournal = async (r: ReadJournalRequest): Promise<ReadPage> => {
    if (!isSyncDeviceId(r.deviceId) || !isEpochId(r.epoch) || !isCount(r.from.segment) || !isCount(r.from.record)) fail('bad-name');
    if (r.from.segment === 0 && r.from.record !== 0) fail('bad-name');
    const limit = pageLimit(r.maxBytes);
    const { folder: f, kid } = requireReadable();
    const state = authenticatedState(f, kid, r.deviceId);
    if (!state) return { records: [], next: r.from, status: 'cloud-pending' };
    const head = state.head;
    // Une autre époque que celle de la tête : aucune tête authentifiée pour elle, rien n'est lu ; l'état annonçant cette époque
    // n'est peut-être pas encore arrivé (choix conservateur : en attente plutôt que terminé, le curseur ne bouge pas).
    if (head.epoch !== r.epoch) return { records: [], next: r.from, status: 'cloud-pending' };
    if (compareCursor(r.from, head) >= 0) return { records: [], next: r.from, status: 'complete' };
    const epochDir = f.devices.get(r.deviceId)?.epochs.get(r.epoch);
    const records: string[] = [];
    let bytes = 0;
    let segment = Math.max(1, r.from.segment);
    let record = r.from.segment === 0 ? 0 : r.from.record;
    let status: ReadPage['status'] = 'complete';
    for (;;) {
      if (compareCursor({ segment, record }, head) >= 0) break;
      const file = epochDir?.segments.get(segment);
      // Segment annoncé absent ou dans le nuage : en attente d'iCloud. Un numéro manquant n'est jamais sauté (choix conservateur :
      // un fichier pas encore arrivé ne se distingue pas d'un trou).
      if (!file || file.availability !== 'local') {
        status = 'cloud-pending';
        break;
      }
      checkFileForRead(file, kid, MAX_SEGMENT_BYTES);
      if (file.header.f !== 'ct-j' || file.header.dev !== r.deviceId || file.header.e !== r.epoch || file.header.n !== segment) fail('bad-header');
      if (record >= file.lines.length) {
        if (segment < head.segment && !file.partialTail) {
          segment += 1;
          record = 0;
          continue;
        }
        status = 'cloud-pending';
        break;
      }
      const line = file.lines[record];
      if (!line) break;
      // Échec de déchiffrement sur un enregistrement que la tête annonce : corruption, rien au-delà (section 1.2).
      if (line.corrupt) {
        status = 'truncated';
        break;
      }
      if (line.sm > SYNC_FORMAT_MAJOR) fail('newer-format');
      const size = utf8Bytes(line.text);
      if (records.length > 0 && bytes + size > limit) {
        status = 'more';
        break;
      }
      records.push(line.text);
      bytes += size;
      record += 1;
    }
    return { records, next: { segment, record }, status };
  };

  const readSnapshot = async (r: ReadSnapshotRequest): Promise<ReadPage> => {
    if (!isSyncDeviceId(r.deviceId) || !isEpochId(r.epoch) || !isFileNumber(r.seq) || !isCount(r.fromRecord)) fail('bad-name');
    const limit = pageLimit(r.maxBytes);
    const { folder: f, kid } = requireReadable();
    const from: RecordCursor = { segment: r.seq, record: r.fromRecord };
    const state = authenticatedState(f, kid, r.deviceId);
    // Seuls les instantanés annoncés par l'état authentifié sont lus (le dernier annoncé et les plus anciens gardés).
    if (!state || state.epoch !== r.epoch || !state.snapshot || r.seq > state.snapshot.seq) return { records: [], next: from, status: 'cloud-pending' };
    const file = f.devices.get(r.deviceId)?.epochs.get(r.epoch)?.snapshots.get(r.seq);
    if (!file || file.availability !== 'local') return { records: [], next: from, status: 'cloud-pending' };
    checkFileForRead(file, kid, MAX_SNAPSHOT_BYTES);
    if (file.header.f !== 'ct-s' || file.header.dev !== r.deviceId || file.header.e !== r.epoch || file.header.n !== r.seq) fail('bad-header');
    const records: string[] = [];
    let bytes = 0;
    let index = r.fromRecord;
    let status: ReadPage['status'] = 'complete';
    while (index < file.lines.length) {
      const line = file.lines[index];
      if (!line) break;
      if (line.corrupt) {
        status = 'truncated';
        break;
      }
      const size = utf8Bytes(line.text);
      if (records.length > 0 && bytes + size > limit) {
        status = 'more';
        break;
      }
      records.push(line.text);
      bytes += size;
      index += 1;
    }
    if (status === 'complete' && file.partialTail) status = 'cloud-pending';
    return { records, next: { segment: r.seq, record: index }, status };
  };

  // --- écritures ----------------------------------------------------------------------------------------------------------------

  const epochDirOf = (f: MemorySyncFolder, self: DeviceId, epoch: EpochId): EpochDir => {
    f.addDeviceFolder(self);
    const dir = f.devices.get(self);
    if (!dir) return fail('io');
    let epochDir = dir.epochs.get(epoch);
    if (!epochDir) {
      epochDir = { segments: new Map(), snapshots: new Map() };
      dir.epochs.set(epoch, epochDir);
    }
    return epochDir;
  };

  /** Une époque antérieure à la sienne n'est plus écrite. `state-mismatch` (tableau des cas limites, ADR 0011 section 11.1). */
  const checkEpochNotOlder = (o: OwnState, epoch: EpochId): void => {
    if (o.epoch !== null && compareEpochs(epoch, o.epoch) < 0) fail('state-mismatch');
  };

  const checkBudget = (count: number): void => {
    if (sealed + count > NONCE_MAX_RECORDS) fail('key-exhausted');
  };

  const appendJournal = async (r: AppendJournalRequest): Promise<AppendJournalResult> => {
    const { folder: f, kid, self, own: o } = requireWritable();
    if (!isEpochId(r.epoch) || !isFileNumber(r.segment) || !isCount(r.expectRecords) || !isPositive(r.sv) || !Array.isArray(r.records)) fail('bad-name');
    // Paramètres mal formés (hlc hors format strict, appel vide) : bad-name ; `hlc-order` est réservé à l'ordre des hlc valides.
    if (!isStrictHlc(r.maxHlc) || r.records.length === 0) fail('bad-name');
    let addBytes = 0;
    const lines: MemLine[] = [];
    for (const text of r.records) {
      if (typeof text !== 'string' || utf8Bytes(text) > MAX_RECORD_PLAINTEXT_BYTES) fail('too-large');
      const line = makeLine(text, SYNC_FORMAT_MAJOR, r.sv);
      addBytes += line.bytes;
      lines.push(line);
    }
    if (addBytes > MAX_APPEND_CALL_BYTES) fail('too-large');
    checkEpochNotOlder(o, r.epoch);
    const sameEpoch = o.epoch === r.epoch;
    const epochDir = f.devices.get(self)?.epochs.get(r.epoch);
    const existing = epochDir?.segments.get(r.segment);
    // Un numéro de segment n'est jamais réutilisé ni pris en arrière ; le fichier doit avoir exactement `expectRecords` lignes.
    if (sameEpoch && r.segment < o.segment) fail('segment-mismatch');
    // Sur le segment de sa tête, l'ajout repart exactement de la tête connue : un fichier tronqué en dessous d'une tête publiée ne
    // fait jamais réutiliser un index d'enregistrement déjà annoncé (le moteur ouvre alors le segment `max + 1`, règle 1).
    if (sameEpoch && r.segment === o.segment && r.expectRecords !== o.record) fail('segment-mismatch');
    if (epochDir && r.segment < maxKey(epochDir.segments)) fail('segment-mismatch');
    if (existing) {
      if (existing.availability !== 'local') fail('cloud-pending');
      if (existing.partialTail || existing.lines.length !== r.expectRecords) fail('segment-mismatch');
      if (existing.lines.length > 0 && fileBytes(existing) + addBytes > SEGMENT_ROTATE_BYTES) fail('segment-full');
    } else if (r.expectRecords !== 0) {
      fail('segment-mismatch');
    }
    // Hlc strictement croissants d'un ajout à l'autre dans une époque ; le contrôle repart de zéro à chaque nouvelle époque.
    if (sameEpoch && o.maxHlc !== null && r.maxHlc <= o.maxHlc) fail('hlc-order');
    checkBudget(lines.length);

    const dir = epochDirOf(f, self, r.epoch);
    let file = dir.segments.get(r.segment);
    if (!file) {
      file = { header: { f: 'ct-j', sm: SYNC_FORMAT_MAJOR, kid, dev: self, e: r.epoch, n: r.segment }, lines: [], partialTail: false, availability: 'local', extraBytes: 0 };
      dir.segments.set(r.segment, file);
    }
    const firstRecord = file.lines.length;
    file.lines.push(...lines);
    sealed += lines.length;
    o.epoch = r.epoch;
    o.segment = r.segment;
    o.record = file.lines.length;
    o.maxHlc = r.maxHlc;
    return { firstRecord, head: { segment: o.segment, record: o.record } };
  };

  const writeState = async (r: { readonly sv: number; readonly state: PublishedDeviceState }): Promise<void> => {
    const { folder: f, kid, self, own: o } = requireWritable();
    const s = r.state;
    if (!isPositive(r.sv)) fail('bad-name');
    if (s.acks.size > MAX_STATE_ACKS || s.forgotten.length > MAX_STATE_FORGOTTEN) fail('too-large');
    const text = JSON.stringify(publishedStateToJson(s));
    if (utf8Bytes(text) > MAX_RECORD_PLAINTEXT_BYTES) fail('too-large');
    // État mal formé (sm ou sv à 0, hlc invalide, clé en trop…) : paramètre invalide, `bad-name` (avenant « Amorce »).
    if (!publishedStateFromJson(JSON.parse(text))) fail('bad-name');
    if (s.deviceId !== self || s.platform !== devicePlatform || s.sm !== SYNC_FORMAT_MAJOR || s.sv !== r.sv) fail('state-mismatch');
    // Réservés jusqu'au lot Y4 (Y-10 et Y-11, section 14.4).
    if (s.forgotten.length > 0 || s.reset !== null) fail('state-mismatch');
    if ((s.pairedBy ?? null) !== o.pairedBy) fail('state-mismatch');
    if (s.stateSeq <= o.stateSeq) fail('state-mismatch');
    checkEpochNotOlder(o, s.epoch);
    const head = s.head;
    if (s.epoch === o.epoch) {
      if (head.segment !== o.segment || head.record !== o.record || head.hlc !== o.maxHlc) fail('state-mismatch');
    } else if (head.segment !== 0 || head.record !== 0 || head.hlc !== null) {
      // Nouvelle époque annoncée avant tout ajout : tête vide.
      fail('state-mismatch');
    }
    checkBudget(1);
    f.addDeviceFolder(self);
    const dir = f.devices.get(self);
    if (!dir) return fail('io');
    const line = makeLine(text, SYNC_FORMAT_MAJOR, r.sv);
    dir.state = { header: { f: 'ct-state', sm: SYNC_FORMAT_MAJOR, kid, dev: self, e: s.epoch, n: s.stateSeq }, lines: [line], partialTail: false, availability: 'local', extraBytes: 0 };
    sealed += 1;
    if (s.epoch !== o.epoch) {
      o.epoch = s.epoch;
      o.segment = 0;
      o.record = 0;
      o.maxHlc = null;
    }
    o.stateSeq = s.stateSeq;
    accepted.set(self, { epoch: s.epoch, seq: s.stateSeq, digest: text, head: s.head });
  };

  const writeSnapshot = async (r: {
    readonly epoch: EpochId;
    readonly seq: number;
    readonly sv: number;
    readonly records: AsyncIterable<readonly string[]>;
  }): Promise<void> => {
    // sync_snapshot_begin
    const { folder: f, kid, self, own: o } = requireWritable();
    if (!isEpochId(r.epoch) || !isFileNumber(r.seq) || !isPositive(r.sv)) fail('bad-name');
    checkEpochNotOlder(o, r.epoch);
    const existing = f.devices.get(self)?.epochs.get(r.epoch);
    // Numéro d'instantané jamais réutilisé dans une époque (choix conservateur, code le plus proche).
    if (existing && r.seq <= maxKey(existing.snapshots)) fail('segment-mismatch');
    const header: FileHeader = { f: 'ct-s', sm: SYNC_FORMAT_MAJOR, kid, dev: self, e: r.epoch, n: r.seq };
    const lines: MemLine[] = [];
    let bytes = headerBytes(header);
    // sync_snapshot_append : le fichier `.tmp` est abandonné à la première erreur.
    for await (const page of r.records) {
      for (const text of page) {
        if (typeof text !== 'string' || utf8Bytes(text) > MAX_RECORD_PLAINTEXT_BYTES) fail('too-large');
        const line = makeLine(text, SYNC_FORMAT_MAJOR, r.sv);
        bytes += line.bytes;
        if (bytes > MAX_SNAPSHOT_BYTES) fail('too-large');
        lines.push(line);
      }
      checkBudget(lines.length);
    }
    // sync_snapshot_commit : renommage atomique.
    epochDirOf(f, self, r.epoch).snapshots.set(r.seq, { header, lines, partialTail: false, availability: 'local', extraBytes: 0 });
    sealed += lines.length;
  };

  const deleteOwn = async (files: readonly OwnFileRef[]): Promise<number> => {
    const { folder: f, self, own: o } = requireWritable();
    for (const ref of files) {
      if (!isEpochId(ref.epoch) || (ref.kind !== 'j' && ref.kind !== 's' && ref.kind !== 'epoch')) fail('bad-name');
      if (ref.kind === 'epoch' ? ref.n !== undefined : !isFileNumber(ref.n)) fail('bad-name');
      if (ref.epoch === o.epoch && ref.kind === 'epoch') fail('current-epoch');
      // Choix conservateur : le segment de la tête courante n'est jamais supprimé (il reçoit encore des ajouts).
      if (ref.epoch === o.epoch && ref.kind === 'j' && ref.n === o.segment) fail('current-epoch');
    }
    const dir = f.devices.get(self);
    let deleted = 0;
    for (const ref of files) {
      const epochDir = dir?.epochs.get(ref.epoch);
      if (!dir || !epochDir) continue;
      if (ref.kind === 'epoch') {
        deleted += epochDir.segments.size + epochDir.snapshots.size;
        dir.epochs.delete(ref.epoch);
      } else if (ref.n !== undefined && (ref.kind === 'j' ? epochDir.segments : epochDir.snapshots).delete(ref.n)) {
        deleted += 1;
      }
    }
    return deleted;
  };

  // --- clé et appairage ---------------------------------------------------------------------------------------------------------

  const folderHasData = (f: MemorySyncFolder): boolean =>
    [...f.devices].some(([name, dir]) => isSyncDeviceId(name) && (dir.state !== null || [...dir.epochs.values()].some((e) => e.segments.size + e.snapshots.size > 0)));

  const folderKids = (f: MemorySyncFolder, only: DeviceId | null): { readonly readable: number; readonly kids: Set<string> } => {
    let readable = 0;
    const kids = new Set<string>();
    for (const [name, dir] of f.devices) {
      if (!isSyncDeviceId(name) || (only !== null && name !== only)) continue;
      if (dir.state && dir.state.availability === 'local') {
        readable += 1;
        kids.add(dir.state.header.kid);
      }
    }
    return { readable, kids };
  };

  const pairingPayload = async (o?: { readonly renew: true }): Promise<PairingPayload> => {
    const instance = livePairing();
    if (!instance) return fail('wrong-window');
    if (instance.mode !== 'show') return fail('wrong-mode');
    const k = requireKey();
    const self = requireBound();
    const f = requireFolder();
    if (o?.renew) {
      openShowConsent();
      instance.generation += 1;
      instance.openedAt = now();
      instance.payloadTaken = false;
    } else if (instance.payloadTaken) {
      // Jeton de consentement à usage unique : un second appel sans « Nouveau code » est refusé.
      return fail('wrong-window');
    }
    const epoch = own && own.folderId === f.id && own.kid === k.kid ? own.epoch : null;
    const expiresAt = instance.openedAt + PAIRING_VALIDITY_MS;
    instance.payloadTaken = true;
    return { qrText: qrTextOf({ key: k.raw, deviceId: self, epoch, expiresAt }), recoveryKey: await recoveryKeyOf(k.raw), expiresAt };
  };

  const importKey = async (input: KeyImportInput): Promise<KeyImportResult> => {
    if (devicePlatform === 'windows') {
      const instance = livePairing();
      if (!instance) return fail('wrong-window');
      if (instance.mode !== 'import') return fail('wrong-mode');
    }
    gate();
    importCalls = prune(importCalls);
    if (importCalls.length >= CONSENT_MAX_IMPORT) fail('rate-limited');
    importCalls.push(now());
    const f = requireFolder();
    requireVault();
    let text: { readonly qr: string } | { readonly recovery: string };
    if ('scan' in input) {
      // Scan lancé par Rust : iPhone seulement (ordre 5).
      if (devicePlatform !== 'ios' || input.scan !== true) return fail('invalid-pairing');
      if (scanResult === null) return fail('consent-denied');
      text = { qr: scanResult };
    } else if ('qrText' in input) {
      text = { qr: input.qrText };
    } else {
      text = { recovery: input.recoveryKey };
    }
    let raw: Bytes;
    let pairedBy: DeviceId | null = null;
    let epoch: EpochId | null = null;
    if ('qr' in text) {
      const qr = typeof text.qr === 'string' ? parseQrText(text.qr) : null;
      if (!qr) return fail('invalid-pairing');
      if (now() > qr.expiresAt + PAIRING_CLOCK_TOLERANCE_MS) return fail('pairing-expired');
      raw = qr.key;
      pairedBy = qr.deviceId;
      epoch = qr.epoch;
    } else {
      const decoded = typeof text.recovery === 'string' ? await keyFromRecovery(text.recovery) : null;
      if (!decoded) return fail('invalid-pairing');
      raw = decoded;
    }
    const kid = await kidOf(raw);
    // Dossier d'abord, clé ensuite : le `kid` doit être porté par le dossier avant tout enregistrement (audit B3).
    const { readable, kids } = folderKids(f, pairedBy);
    if (readable === 0) return fail('cloud-pending');
    if (!kids.has(kid)) return fail('key-mismatch');
    if (key && key.kid !== kid) askConsent();
    if (!key || key.kid !== kid) {
      key = { raw, kid };
      sealed = 0; // budget de nonces compté par clé
    }
    if (!own || own.folderId !== f.id || own.kid !== kid) own = bound ? rebuildOwn(f, kid, bound) : null;
    if (own && pairedBy !== null) own.pairedBy = pairedBy;
    pendingPairedBy = pairedBy;
    pairing = null; // la fenêtre est détruite à la réussite
    return { kid, pairedBy, epoch };
  };

  const platform: MemorySyncPlatform = {
    available: () => options.available ?? true,
    folder: {
      info: async () => ({ configured: folder !== null, label: folder?.label ?? null, kind: folder?.kind ?? 'unknown', pinned: folder?.kind === 'icloud' }),
      choose: async () => {
        const next = chooserNext;
        if (!next) return null;
        // Un dossier différent remet `own.json` à zéro (section 1.4).
        if (!folder || folder.id !== next.id) {
          own = null;
          accepted.clear(); // l'anti-rejeu vaut pour un dossier : les états d'un autre dossier ne comparent rien
        }
        folder = next;
        return { configured: true, label: next.label, kind: next.kind, pinned: next.kind === 'icloud' };
      },
      forget: async ({ eraseKey }) => {
        if (eraseKey) requireVault();
        if (eraseKey && key) {
          gate();
          askConsent();
        }
        folder = null;
        own = null;
        bound = null;
        pairing = null;
        pendingPairedBy = null;
        accepted.clear();
        if (eraseKey) {
          key = null;
          sealed = 0;
        }
      },
    },
    key: {
      status: async () => {
        requireVault();
        return { present: key !== null, kid: key?.kid ?? null };
      },
      create: async () => {
        requireVault();
        if (key) return fail('key-exists');
        const f = requireFolder();
        if (folderHasData(f)) return fail('folder-has-data');
        const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
        key = { raw, kid: await kidOf(raw) };
        own = null;
        sealed = 0;
        return { kid: key.kid };
      },
      openPairing: async (mode) => {
        if (devicePlatform !== 'windows') return fail('wrong-window');
        if (mode !== 'show' && mode !== 'import') return fail('wrong-mode');
        requireFolder();
        if (mode === 'show') {
          requireKey();
          requireBound();
        }
        // Libellé `pairing` déjà pris (avant ou pendant la boîte) : refus, rien n'est créé.
        if (livePairing()) return fail('consent-denied');
        if (mode === 'show') openShowConsent();
        else gate();
        pairing = { mode, generation: 1, openedAt: now(), payloadTaken: false };
      },
      pairingPayload,
      closePairing: async () => {
        if (!livePairing()) return fail('wrong-window');
        pairing = null;
      },
      import: importKey,
    },
    bindDevice: async (deviceId) => {
      if (!isSyncDeviceId(deviceId)) return fail('bad-name');
      requireFolder();
      if (bound !== null && bound !== deviceId) return fail('already-bound');
      bound = deviceId;
      if (pendingPairedBy !== null) {
        const f = requireFolder();
        if (key && (!own || own.folderId !== f.id || own.kid !== key.kid)) own = rebuildOwn(f, key.kid, deviceId);
        if (own) own.pairedBy = pendingPairedBy;
        pendingPairedBy = null;
      }
    },
    scan,
    readJournal,
    appendJournal,
    writeState,
    writeSnapshot,
    readSnapshot,
    deleteOwn,
    restoreMarker: {
      get: async () => marker,
      clear: async () => {
        marker = null;
      },
    },
    testing: {
      setConsent: (answer) => {
        consentAnswer = answer;
      },
      setForeground: (value) => {
        foreground = value;
      },
      setChooser: (next) => {
        chooserNext = next;
      },
      setVaultAvailable: (value) => {
        vaultAvailable = value;
      },
      setRestoreMarker: (value) => {
        marker = value;
      },
      setScanResult: (text) => {
        scanResult = text;
      },
      pairing: () => {
        const instance = livePairing();
        return instance ? { mode: instance.mode, generation: instance.generation } : null;
      },
      consentPrompts: () => prompts,
      sealedRecords: () => sealed,
      setSealedRecords: (count) => {
        sealed = count;
      },
      dropOwnState: () => {
        own = null;
      },
    },
  };
  return platform;
}
