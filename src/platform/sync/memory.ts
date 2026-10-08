import type { DeviceId, Hlc, IsoDateTime } from '../../domain/types';
import { omitKey } from '../../domain/omitKey';
import {
  CONSENT_BLOCK_MS,
  CONSENT_MAX_IMPORT,
  CONSENT_MAX_SHOW,
  CONSENT_WINDOW_MS,
  FOLDER_STOP_BYTES,
  FOLDER_WARN_BYTES,
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
  MAX_STATE_CLOSED_SEGMENTS,
  NONCE_MAX_RECORDS,
  NONCE_WARN_RECORDS,
  PAIRING_CLOCK_TOLERANCE_MS,
  PAIRING_QR_PREFIX,
  PAIRING_VALIDITY_MS,
  RECOVERY_KEY_PREFIX,
  SEGMENT_ROTATE_BYTES,
  STATE_FILE,
  STATE_NEXT_FILE,
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
  type ClosedSegment,
  type DeviceAck,
  type EpochId,
  type FileHeader,
  type ForgottenDevice,
  type PublishedDeviceState,
  type RecordCursor,
  type ResetNotice,
  type SyncDevicePlatform,
  parseEpochId,
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
  type ForgottenDeleteResult,
  type ForgottenRegistryView,
  type ResetView,
  type RestoreMarker,
  type SyncErrorCode,
  type SyncFolderInfo,
  type SyncPlatform,
  type CameraPermission,
  type ScanImportOutcome,
} from './types';
import { hlcMs, parsePublishedStateText, parseSnapshotRecord } from '../../domain/sync/parse';
import {
  citedDevices,
  completedForgotten,
  coversForgotten,
  cutoff,
  declarationAuthor,
  declarationHlc,
  FORGET_DECLARE_LIMIT,
  forgetOrder,
  forgottenDeleteCheck,
  learnDeclarations,
  seenDevices,
  type ForgetKnownDevice,
  type SnapshotEndRead,
} from '../../domain/sync/retention';
import {
  resetPrecondition,
  resetWaiting,
  resetWinner,
  restoreCandidates,
  type OpenedEpoch,
  type ResetCandidate,
  type ResetKnownDevice,
  type ResetPreconditionDevice,
} from '../../domain/sync/epoch';
import { DEVICE_EXPIRY_MS, HYDRATE_CYCLE_TIMEOUT_MS, HYDRATE_FILE_TIMEOUT_MS } from '../../domain/sync/limits';

/**
 * Implémentation mémoire de `SyncPlatform` (ADR 0011, section 0 ; Y-01, Y-02, Y-06, Y-08) pour Vitest, Playwright et le navigateur de
 * dev. Elle tient le rôle du côté Rust : dossier choisi, coffre, `own.json`, fichiers par appareil et par époque, appairage et
 * confirmations natives, bornes de la section 1.6, avec les mêmes codes d'erreur. Jamais utilisée dans l'app installée.
 *
 * Différences assumées avec Rust : aucun chiffrement (les enregistrements sont gardés en texte clair ; la taille sur disque est
 * calculée par `encryptedLineBytes`, bourrage compris) ; le `kid` est dérivé comme en Rust (HKDF-SHA256, Web Crypto). Le chiffrement
 * réel est vérifié par le codec de référence et ses vecteurs croisés avec Rust (`tests/sim/syncCodec.ts`). Plusieurs plateformes peuvent
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
  /** Y-11 : `state.next.ctx` (état sous la nouvelle clé pendant une réinitialisation). */
  nextState: MemFile | null;
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
    readonly label: string = 'CircleTasks',
    readonly kind: SyncFolderInfo['kind'] = 'icloud',
  ) {}

  /** Dossier d'appareil vide (nom quelconque : un nom non UUID est ignoré par `scan`). */
  addDeviceFolder(name: string): void {
    if (!this.devices.has(name)) this.devices.set(name, { state: null, nextState: null, epochs: new Map(), strays: 0 });
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
    if (file === STATE_NEXT_FILE) {
      dir.nextState = null;
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
    const names: string[] = [...(dir.state ? [STATE_FILE] : []), ...(dir.nextState ? [STATE_NEXT_FILE] : [])];
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
  if (file === STATE_NEXT_FILE) return dir.nextState;
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
    if (dir.nextState) total += fileBytes(dir.nextState);
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
  /** Y-TECH-02 (§21 point 2) : segments clos de `epoch` et ce que l'état a pu en annoncer (`own.json` de Rust, `closed`). */
  closed: ClosedSegment[];
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
  /** iPhone : texte lu par le prochain scan du QR (null : scan annulé) ; consommé par `scanAndImport`. */
  setScanResult(text: string | null): void;
  /** iPhone : autorisation de la caméra (`prompt` : demandée au prochain scan, `answer` : réponse de l'utilisateur). */
  setCameraPermission(state: CameraPermission, answer?: 'granted' | 'denied'): void;
  /** iPhone : ouvertures des réglages d'iOS demandées. */
  cameraSettingsOpened(): number;
  /**
   * ADR 0011 §22 point 4 : téléchargement simulé des fichiers « dans le nuage » (durée en ms, null : jamais téléchargés). Un fichier lu est
   * téléchargé si sa durée tient dans 60 s et dans le reste du budget du cycle (3 minutes, ou `hydrateBudgetMs` du scan) ; le budget est
   * consommé comme le ferait Rust (durée, ou délai accordé s'il est dépassé).
   */
  setHydrationDelay(ms: number | null): void;
  /** Reste du budget d'hydratation du cycle en cours (ms). */
  hydrationBudgetLeft(): number;
  /** Instance `pairing` ouverte (mode, génération), ou null. */
  pairing(): { readonly mode: PairingMode; readonly generation: number } | null;
  /** Nombre de confirmations natives affichées. */
  consentPrompts(): number;
  /** Enregistrements scellés avec la clé (budget de nonces). */
  sealedRecords(): number;
  setSealedRecords(count: number): void;
  /** Simule la perte de `own.json` (dossier de configuration effacé). */
  dropOwnState(): void;
  /** Y-TECH-02 : `own.json` écrit avant la story (aucune entrée `closed`) : l'état suivant est publié sans `closed`. */
  clearClosedSegments(): void;
  /** Y-10 : réinitialisation en cours (entrée `.next` au coffre, Y-11). */
  setResetInProgress(value: boolean): void;
  /** Y-10 : déclarations de `sync/forgotten.json`. */
  forgottenDeclarations(): readonly ForgottenDevice[];
  /** Y-10 : simule la perte de `sync/forgotten.json`. */
  dropForgottenFile(): void;
  /** Y-10 : registre (liste maître, terminés), ou null. */
  forgottenRegistry(): { readonly entries: readonly ForgottenDevice[]; readonly done: readonly DeviceId[] } | null;
  /** Y-10 : registre illisible (`io`). */
  setForgottenFileCorrupt(value: boolean): void;
  /** Y-11 : arrêt simulé (`io`) avant l'étape nommée de la bascule (`switch-1` à `switch-6`) ou de la perte (`supersede-2` à `-4`), une fois. */
  interruptBefore(step: string | null): void;
  /** Y-11 : registre `sync/reset.json` (copie), ou null. */
  resetRecord(): MemResetRecordView | null;
  /** Y-11 : `kid` de l'entrée `.next` du coffre, ou null. */
  nextKid(): string | null;
  /** Y-11 : enregistrements scellés avec la nouvelle clé pendant la transition. */
  sealedNextRecords(): number;
}

/** Y-11 : registre de la réinitialisation vu par les tests (aucune clé). */
export interface MemResetRecordView {
  readonly role: 'initiator' | 'joined';
  readonly kid: string;
  readonly epoch: EpochId;
  readonly by: DeviceId;
  readonly stage: 'created' | 'announced' | 'opened';
  readonly base: { readonly epoch: EpochId | null; readonly segment: number; readonly record: number; readonly maxHlc: Hlc | null } | null;
  readonly superseded: { readonly epoch: EpochId | null; readonly by: DeviceId | null; readonly done: boolean; readonly restore: boolean } | null;
  readonly switchStep: number;
  readonly noticeSeq: number | null;
}

/** Y-11 : `sync/reset.json` tenu par « Rust » (mêmes champs que `ResetRecord` de `reset.rs`). */
interface MemResetRecord {
  readonly folderId: string;
  readonly deviceId: DeviceId;
  readonly role: 'initiator' | 'joined';
  readonly kid: string;
  readonly epoch: EpochId;
  readonly by: DeviceId;
  notice: ResetNotice | null;
  noticeEpoch: EpochId | null;
  /** `stateSeq` de l'état qui porte l'annonce (revue 1). */
  noticeSeq: number | null;
  /** Dernier état écrit sous l'ancienne clé (audit 5) : seul repris par l'anti-rejeu de soi si la réinitialisation perd. */
  kState: { seq: number; digest: string } | null;
  /** Réassocié : état de l'auteur lu à l'import (seconde revue, point 3). */
  authorAtImport: { seq: number; epoch: EpochId } | null;
  stage: 'created' | 'announced' | 'opened';
  base: { epoch: EpochId | null; segment: number; record: number; maxHlc: Hlc | null } | null;
  superseded: { epoch: EpochId | null; by: DeviceId | null; done: boolean; restore: boolean } | null;
  switchStep: number;
}

const RESET_STAGES = ['created', 'announced', 'opened'] as const;
const stageRank = (stage: MemResetRecord['stage']): number => RESET_STAGES.indexOf(stage);

export interface MemorySyncPlatform extends SyncPlatform {
  readonly testing: MemorySyncTesting;
}

function fail(code: SyncErrorCode): never {
  throw new SyncPlatformError(code);
}

/** Entrées supprimées au plus par appel de `sync_forgotten_delete` (Y-10, `MAX_FORGOTTEN_DELETE_ENTRIES` de `forget.rs`). */
const MAX_FORGOTTEN_DELETE_ENTRIES = 1_000;

/** hlc connus d'un état authentifié (dernier cycle, tête, accusés, déclarations) : `state_hlcs` de `forget.rs`. */
function stateHlcs(state: PublishedDeviceState): Hlc[] {
  return [state.lastSyncHlc, ...(state.head.hlc ? [state.head.hlc] : []), ...[...state.acks.values()].flatMap((a) => (a.hlc ? [a.hlc] : [])), ...state.forgotten.map((f) => f.at)];
}

/** Registre de l'oubli tenu par « Rust » (`forgotten.json`). */
interface MemRegistry {
  readonly folderId: string;
  readonly deviceId: DeviceId;
  readonly entries: ForgottenDevice[];
  readonly done: DeviceId[];
  /** Arrêt définitif (§18 point 12), jamais effacé. */
  readonly selfForgotten: Hlc | null;
}

/** `selfForgotten` posé si l'ordre total oublie l'appareil du registre (jamais effacé), comme `note_self_forgotten` de Rust. */
const withSelfForgotten = (reg: MemRegistry): MemRegistry => {
  if (reg.selfForgotten !== null) return reg;
  const verdict = forgetOrder(reg.entries).get(reg.deviceId);
  return verdict ? { ...reg, selfForgotten: verdict.at } : reg;
};

/** Écart maximal entre le stateSeq lu en clair dans l'en-tête de son propre état remplacé et les sources authentifiées (comme Rust). */
const MAX_UNAUTHENTICATED_SEQ_JUMP = 1_000_000;

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
  /**
   * Écrivains d'instantané ouverts (`sync_snapshot_begin` sans `commit`), comme `SyncCore.snapshots` de Rust : un écrivain dont les pages
   * ont été coupées par l'appelant (cycle interrompu) reste ouvert jusqu'à l'abandon ; au plus `MAX_OPEN_SNAPSHOTS`.
   */
  const openWriters = new Map<number, { readonly epoch: EpochId; readonly seq: number }>();
  let nextWriter = 0;
  const MAX_OPEN_SNAPSHOTS = 4;

  let consentAnswer = true;
  let foreground = true;
  let prompts = 0;
  let showOpenings: number[] = [];
  let importCalls: number[] = [];
  let blockedUntil = 0;
  let pairing: PairingInstance | null = null;
  let scanResult: string | null = null;
  /** iPhone (§23 point 2) : autorisation de la caméra simulée, réponse à la demande, réglages ouverts. */
  let camera: CameraPermission = 'granted';
  let cameraAnswer: 'granted' | 'denied' = 'granted';
  let settingsOpened = 0;
  /** Téléchargement simulé (§22 point 4) : durée, et reste du budget du cycle ouvert par le dernier scan. */
  let hydrationDelay: number | null = null;
  let hydrationLeft = HYDRATE_CYCLE_TIMEOUT_MS;
  /** Fichier lisible localement, après un téléchargement simulé s'il est dans le nuage et que le budget le permet. */
  const hydrated = (file: MemFile): boolean => {
    if (file.availability === 'cloud' && hydrationDelay !== null) {
      const allowed = Math.min(HYDRATE_FILE_TIMEOUT_MS, hydrationLeft);
      if (allowed > 0 && hydrationDelay <= allowed) {
        file.availability = 'local';
        hydrationLeft -= hydrationDelay;
      } else {
        hydrationLeft -= allowed;
      }
    }
    return file.availability === 'local';
  };
  /** `pairedBy` mémorisé à l'import quand l'appareil n'est pas encore lié (reporté dans `own.json` à la liaison). */
  let pendingPairedBy: DeviceId | null = null;
  /** `sync/forgotten.json` (Y-10, §18 point 3) : liste maître, terminés ; lié au dossier et à l'identité (l'anti-rejeu est `accepted`). */
  let registry: MemRegistry | null = null;
  /** Registre illisible (crochet de test) : `io`. */
  let registryCorrupt = false;
  /** Ouvertures de la boîte « Oublier cet appareil » (fenêtre de 10 minutes). */
  let forgetOpenings: number[] = [];
  /** Entrée `.next` orpheline au coffre (crochet de test de Y-10) : réinitialisation en cours sans registre. */
  let resetPending = false;
  /** Y-11 : entrée `.next` du coffre (nouvelle clé d'une réinitialisation). */
  let nextKey: { readonly raw: Bytes; readonly kid: string } | null = null;
  /** Y-11 : `sync/reset.json`. */
  let resetRecord: MemResetRecord | null = null;
  /** Y-11 : budget de nonces de la nouvelle clé (`usage.next.json`). */
  let sealedNext = 0;
  /** Y-11 : ouvertures de la boîte « Réinitialiser la synchronisation » (fenêtre de 10 minutes). */
  let resetOpenings: number[] = [];
  /** Y-11 : arrêt simulé avant l'étape nommée (une fois). */
  let interruptAt: string | null = null;
  /** Remarques finales : anti-rejeu et derniers accusés des `state.ctx` relus sous l'ancienne clé pour la coupure (comme Rust). */
  const kAccepted = new Map<string, AcceptedState>();
  const kAcks = new Map<string, ReadonlyMap<DeviceId, DeviceAck>>();
  /** Seconde revue, point 2 : dernière synchro (ms) de chaque appareil vue au dernier scan (expiré à 180 jours). */
  const lastSeen = new Map<string, number>();
  /** Y-11 (§18 point 17) : `sync/import-failure.json`. */
  let importFailure: { readonly folderId: string; readonly code: SyncErrorCode; readonly at: string; readonly next: boolean } | null = null;

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
    refuseIfSelfForgotten(f, self);
    if (!own || own.folderId !== f.id || own.kid !== k.kid) own = rebuildOwn(f, k.kid, self);
    return { folder: f, kid: k.kid, self, own };
  };

  /** Arrêt définitif (§18 point 12) : appareil qui s'est vu oublié → toute écriture refusée (`state-mismatch`). */
  const refuseIfSelfForgotten = (f: MemorySyncFolder, self: DeviceId): void => {
    if (loadRegistry(f, self)?.selfForgotten) fail('state-mismatch');
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
    // Son propre state.ctx en transfert (nuage, ligne incomplète) sans accusé qui borne : en attente, rien n'est retenu (revue 4 du lot
    // Y1, même règle que Rust).
    if (mine?.status === 'cloud-pending' && acks.length === 0) fail('cloud-pending');
    // État d'une version plus récente du format : jamais réécrit (Y-07, « Mettez à jour l'app »).
    if (mine?.status === 'newer-format') fail('newer-format');
    // Remplacé ou illisible (étranger, corrompu, rejeu, trop grand) : reconstruit sans lui, stateSeq au moins égal à l'état accepté et
    // au numéro lu en clair dans l'en-tête du fichier remplacé, pour le réécrire aussitôt (§1.4, revue B1) ; ce numéro non authentifié
    // n'est retenu que s'il dépasse d'au plus 1 000 000 les sources authentifiées (accusés, état accepté), sinon ignoré.
    let replacedSeq = 0;
    if (mine && mine.status !== 'ok' && mine.status !== 'missing' && mine.status !== 'cloud-pending') {
      const authenticated = Math.max(accepted.get(self)?.seq ?? 0, ...acks.map((a) => a.stateSeq));
      const header = dir?.state && dir.state.header.f === 'ct-state' && dir.state.header.dev === self ? dir.state.header.n : 0;
      replacedSeq = header <= authenticated + MAX_UNAUTHENTICATED_SEQ_JUMP ? Math.max(authenticated, header) : authenticated;
    }
    const epochs: EpochId[] = [...(state ? [state.epoch] : []), ...(dir?.epochs.keys() ?? []), ...acks.map((a) => a.epoch)];
    const epoch = epochs.reduce<EpochId | null>((best, e) => (best === null || compareEpochs(e, best) > 0 ? e : best), null);
    const stateSeq = Math.max(state?.stateSeq ?? 0, replacedSeq, ...acks.map((a) => a.stateSeq));
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
    // Y-TECH-02 (§21 point 2) : entrées `closed` de son seul état authentifié de la même époque, sous la tête reconstruite, qu'aucun
    // accusé authentifié sur soi ne dépasse dans ce segment ; aucune autre entrée n'est inventée.
    const closed = state && state.epoch === epoch ? (state.closed ?? []).filter((c) => c.segment < head.segment && !acks.some((a) => a.epoch === epoch && a.segment === c.segment && a.record > c.records)) : [];
    return { folderId: f.id, kid, epoch, segment: head.segment, record: head.record, maxHlc, stateSeq, pairedBy: state?.pairedBy ?? null, closed: closed.map((c) => ({ ...c })) };
  };

  /** Y-TECH-02 : entrée `closed` d'un segment qui se ferme ; au-delà de 1 024, la plus ancienne est retirée (journal `closed-dropped` de Rust). */
  const closeSegment = (o: OwnState, segment: number, records: number): void => {
    o.closed.push({ segment, records });
    while (o.closed.length > MAX_STATE_CLOSED_SEGMENTS) o.closed.shift();
  };

  // --- confirmations natives (consent.rs) ---------------------------------------------------------------------------------------

  const prune = (list: number[]): number[] => list.filter((at) => now() - at < CONSENT_WINDOW_MS);

  const gate = (): void => {
    if (!foreground) fail('not-foreground');
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

  // --- réinitialisation (Y-11, reset.rs) : clé de l'époque visée ------------------------------------------------------------------

  const interrupt = (step: string): void => {
    if (interruptAt === step) {
      interruptAt = null;
      fail('io');
    }
  };

  const loadReset = (f: MemorySyncFolder, self: DeviceId): MemResetRecord | null =>
    resetRecord && resetRecord.folderId === f.id && resetRecord.deviceId === self ? resetRecord : null;

  /** Nouvelle clé active (registre non perdu et entrée `.next` de même kid) et époque visée. */
  const activeNext = (): { readonly kid: string; readonly epoch: EpochId } | null => {
    if (!folder || bound === null) return null;
    const record = loadReset(folder, bound);
    return record && record.superseded === null && nextKey && nextKey.kid === record.kid ? { kid: record.kid, epoch: record.epoch } : null;
  };

  /** Kid qui chiffre une époque : la nouvelle clé pour l'époque visée, sinon la clé locale. */
  const kidFor = (epoch: EpochId, localKid: string): string => {
    const next = activeNext();
    return next && next.epoch === epoch ? next.kid : localKid;
  };

  // --- lecture d'un état publié -------------------------------------------------------------------------------------------------

  interface StateRead {
    readonly kid: string | null;
    readonly state: PublishedDeviceState | null;
    readonly status: DeviceStateStatus;
    /** Y-11 : état lu dans `state.next.ctx`. */
    readonly fromNext?: boolean;
  }

  const anyKid = (dir: DeviceDir): string | null => {
    for (const epochDir of dir.epochs.values()) {
      for (const file of [...epochDir.segments.values(), ...epochDir.snapshots.values()]) {
        if (file.availability === 'local') return file.header.kid;
      }
    }
    return null;
  };

  /**
   * État présenté (Y-11, même règle que `read_state` de `store.rs`) : pendant une réinitialisation, `state.next.ctx` sous la nouvelle clé,
   * puis `state.ctx` sous la nouvelle clé ou la clé locale (d'après l'en-tête) ; sinon `state.ctx` sous la clé locale, et `state.next.ctx`
   * seulement si `state.ctx` est d'une autre clé (appareil associé pendant la transition).
   */
  const readState = (deviceId: string, dir: DeviceDir, localKid: string, remember: boolean): StateRead => {
    const next = activeNext();
    if (next) {
      const first = readStateFile(deviceId, dir, 'next', [next.kid], remember);
      if (first.status !== 'missing' && first.status !== 'foreign') return first;
      return readStateFile(deviceId, dir, 'state', [next.kid, localKid], remember);
    }
    const read = readStateFile(deviceId, dir, 'state', [localKid], remember);
    if (read.status === 'foreign') {
      const other = readStateFile(deviceId, dir, 'next', [localKid], remember);
      if (other.status === 'ok') return other;
    }
    return read;
  };

  /** Lecture d'un fichier d'état : bornes, en-tête, clé (d'après l'en-tête), majeure, analyse stricte, anti-rejeu (`replay` faux : sans). */
  const readStateFile = (deviceId: string, dir: DeviceDir, which: 'state' | 'next', kids: readonly string[], remember: boolean, replay = true): StateRead => {
    const fromNext = which === 'next';
    const file = fromNext ? dir.nextState : dir.state;
    if (!file) return { kid: fromNext ? null : anyKid(dir), state: null, status: 'missing', fromNext };
    if (!hydrated(file)) return { kid: fromNext ? null : anyKid(dir), state: null, status: 'cloud-pending', fromNext };
    const read = readFileState(deviceId, file, kids, remember, replay);
    return { ...read, fromNext };
  };

  const readFileState = (deviceId: string, file: MemFile, kids: readonly string[], remember: boolean, replay: boolean): StateRead => {
    if (fileBytes(file) > MAX_STATE_FILE_BYTES) return { kid: null, state: null, status: 'too-large' };
    const h = file.header;
    if (h.f !== 'ct-state' || h.dev !== deviceId || !kids.includes(h.kid)) return { kid: h.kid, state: null, status: 'foreign' };
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
    const previous = replay ? accepted.get(deviceId) : undefined;
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
    // Fichiers attendus et pas encore lisibles : `state.ctx`, puis ce que la tête authentifiée annonce (jamais au-delà), plafonnés à
    // 10 000 entrées, `incomplete` au-delà (même règle que `store.rs`, Y-TECH-02).
    const pending: { file: string; availability: FileAvailability }[] = [];
    const push = (file: string, availability: FileAvailability): void => {
      if (pending.length >= MAX_SCAN_ENTRIES_PER_FOLDER) incomplete = true;
      else pending.push({ file, availability });
    };
    if (dir.state && dir.state.availability !== 'local') push(STATE_FILE, dir.state.availability);
    // Y-11 : `state.next.ctx` attendu seulement de l'appareil dont l'état présenté en vient.
    if (read.fromNext === true && dir.nextState && dir.nextState.availability !== 'local') push(STATE_NEXT_FILE, dir.nextState.availability);
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
        if (availability !== 'local') push(`${state.epoch}/${segmentFileName(n)}`, availability);
        if (incomplete && pending.length >= MAX_SCAN_ENTRIES_PER_FOLDER) break;
      }
    }
    if (state && epochDir) {
      for (const [n, file] of [...epochDir.snapshots].sort(([a], [b]) => a - b)) {
        if (state.snapshot && n <= state.snapshot.seq && file.availability !== 'local') {
          push(`${state.epoch}/${snapshotFileName(n)}`, file.availability);
        }
      }
    }
    return { scan: { deviceId, kid: read.kid, state, stateStatus: read.status, epochs, pending }, incomplete };
  };

  const scan = async (r: ScanRequest): Promise<FolderScan> => {
    const keepList: unknown = (r as Partial<ScanRequest> | undefined)?.keep;
    if (!Array.isArray(keepList) || !keepList.every((id) => isSyncDeviceId(id))) return fail('bad-name');
    // ADR 0011 §22 point 4 : budget d'hydratation réduit (entier de 1 à 180 000), sinon `bad-name` ; il ouvre le cycle d'hydratation.
    const budget: unknown = (r as Partial<ScanRequest> | undefined)?.hydrateBudgetMs;
    if (budget !== undefined && (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1 || budget > HYDRATE_CYCLE_TIMEOUT_MS)) return fail('bad-name');
    hydrationLeft = typeof budget === 'number' ? budget : HYDRATE_CYCLE_TIMEOUT_MS;
    requireReadable();
    // Y-11 : perte constatée et bascule (et sa reprise) faites avant la lecture du dossier, qui reflète alors les clés en vigueur.
    let reset: ResetView | null = null;
    if (bound !== null) {
      const f0 = requireFolder();
      ensureRegistry(f0, requireKey().kid, bound);
      reset = resetPass(f0, bound);
    }
    const { folder: f, kid } = requireReadable();
    for (const [name, dir] of f.devices) {
      if (!isSyncDeviceId(name)) continue;
      const read = readState(name, dir, kid, false);
      if (read.status === 'ok' && read.state) lastSeen.set(name, hlcMs(read.state.lastSyncHlc));
    }
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
    // Y-10 (§18 point 3) : déclarations retenues des états authentifiés apprises dans la liste maître, gardée avant de rendre le scan.
    let forgotten: ForgottenRegistryView = { entries: [], done: [], overflow: false, accepted: [], selfForgotten: null };
    if (bound !== null) {
      const reg = ensureRegistry(f, kid, bound);
      const learned = learnDeclarations(reg.entries, kept.filter((d) => d.stateStatus === 'ok' && d.state).flatMap((d) => (d.state as PublishedDeviceState).forgotten));
      registry = withSelfForgotten({ ...reg, entries: learned.entries });
      forgotten = { entries: learned.entries, done: [...reg.done], overflow: learned.overflow, accepted: ([...accepted.keys()] as DeviceId[]).sort(), selfForgotten: registry.selfForgotten };
    }
    return {
      devices: kept.sort((a, b) => (a.deviceId < b.deviceId ? -1 : 1)),
      ignored: ignored + dropped,
      totalBytes: folderBytes(f),
      tooManyDevices: dropped > 0,
      incomplete,
      // Y-TECH-02 : avertissements (mêmes seuils que Rust) ; nonces : clé locale ou nouvelle clé d'une réinitialisation.
      folderLarge: folderBytes(f) > FOLDER_WARN_BYTES,
      nonceWarning: Math.max(sealed, sealedNext) > NONCE_WARN_RECORDS,
      forgotten,
      reset,
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
    const { folder: f, kid: localKid } = requireReadable();
    const state = authenticatedState(f, localKid, r.deviceId);
    if (!state) return { records: [], next: r.from, status: 'cloud-pending' };
    const kid = kidFor(r.epoch, localKid);
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
    // Y-TECH-02 (§21 point 2) : nombre d'enregistrements annoncé de chaque segment clos (sans entrée : règle d'avant).
    const closedCount = (n: number): number | null => (n < head.segment ? (state.closed?.find((c) => c.segment === n)?.records ?? null) : null);
    for (;;) {
      if (compareCursor({ segment, record }, head) >= 0) break;
      // Segment clos déjà lu jusqu'au nombre annoncé : segment suivant, sans lire le fichier (lignes en trop ignorées).
      const count = closedCount(segment);
      if (count !== null && record >= count) {
        segment += 1;
        record = 0;
        continue;
      }
      const file = epochDir?.segments.get(segment);
      // Segment annoncé absent ou dans le nuage : en attente d'iCloud. Un numéro manquant n'est jamais sauté (choix conservateur :
      // un fichier pas encore arrivé ne se distingue pas d'un trou).
      if (!file || !hydrated(file)) {
        status = 'cloud-pending';
        break;
      }
      checkFileForRead(file, kid, MAX_SEGMENT_BYTES);
      if (file.header.f !== 'ct-j' || file.header.dev !== r.deviceId || file.header.e !== r.epoch || file.header.n !== segment) fail('bad-header');
      if (record >= file.lines.length) {
        // Segment clos avec entrée : il en manque (version ancienne livrée par iCloud, troncature) → attente, jamais le segment suivant.
        if (count === null && segment < head.segment && !file.partialTail) {
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
    const { folder: f, kid: localKid } = requireReadable();
    const from: RecordCursor = { segment: r.seq, record: r.fromRecord };
    const state = authenticatedState(f, localKid, r.deviceId);
    const kid = kidFor(r.epoch, localKid);
    if (r.tail === true) {
      // Y-10 (§18 point 11) : fin de l'instantané annoncé seulement.
      if (!state) return { records: [], next: from, status: 'cloud-pending' };
      if (state.epoch !== r.epoch || state.snapshot?.seq !== r.seq) fail('state-mismatch');
    }
    // Seuls les instantanés annoncés par l'état authentifié sont lus (le dernier annoncé et les plus anciens gardés).
    if (!state || state.epoch !== r.epoch || !state.snapshot || r.seq > state.snapshot.seq) return { records: [], next: from, status: 'cloud-pending' };
    const file = f.devices.get(r.deviceId)?.epochs.get(r.epoch)?.snapshots.get(r.seq);
    if (!file || !hydrated(file)) return { records: [], next: from, status: 'cloud-pending' };
    checkFileForRead(file, kid, MAX_SNAPSHOT_BYTES);
    if (file.header.f !== 'ct-s' || file.header.dev !== r.deviceId || file.header.e !== r.epoch || file.header.n !== r.seq) fail('bad-header');
    if (r.tail === true) {
      const last = file.lines[file.lines.length - 1];
      if (file.partialTail || !last) return { records: [], next: from, status: 'cloud-pending' };
      if (last.corrupt) return { records: [], next: { segment: r.seq, record: file.lines.length - 1 }, status: 'truncated' };
      return { records: [last.text], next: { segment: r.seq, record: file.lines.length }, status: 'complete' };
    }
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

  const checkBudget = (count: number, next = false): void => {
    if ((next ? sealedNext : sealed) + count > NONCE_MAX_RECORDS) fail('key-exhausted');
  };

  /** Budget de la clé qui chiffre `epoch` (Y-11 : la nouvelle clé repart de zéro). */
  const isNextEpoch = (epoch: EpochId): boolean => activeNext()?.epoch === epoch;
  const addSealed = (count: number, next: boolean): void => {
    if (next) sealedNext += count;
    else sealed += count;
  };

  /** Y-11 : ancienne époque figée dès l'annonce (ou l'import de la nouvelle clé) : seule l'époque visée reçoit des ajouts. */
  const refuseFrozenEpoch = (f: MemorySyncFolder, self: DeviceId, epoch: EpochId): void => {
    const record = loadReset(f, self);
    if (record && record.superseded === null && (record.role === 'joined' || stageRank(record.stage) >= stageRank('announced')) && epoch !== record.epoch) fail('state-mismatch');
  };

  /**
   * Garde d'époque (§18 point 16, audit 8 ; `refuse_epoch_open` de Rust) : rien dans l'époque visée avant l'annonce ; une époque
   * supérieure à celle de `own.json` est refusée si `reset.json` existe et qu'elle n'est pas la sienne (ou la gagnante d'une perte), ou,
   * sans registre, si une annonce valide d'un autre appareil l'emporte (sauf l'époque restaurée gagnante).
   */
  const refuseEpochOpen = (f: MemorySyncFolder, kid: string, self: DeviceId, o: OwnState, epoch: EpochId): void => {
    const record = loadReset(f, self);
    if (record && record.superseded === null && record.role === 'initiator' && stageRank(record.stage) < stageRank('announced') && epoch === record.epoch) fail('state-mismatch');
    if (o.epoch === null || !isEpochId(epoch) || compareEpochs(epoch, o.epoch) <= 0) return;
    const allowed = record ? (record.superseded === null ? record.epoch : record.superseded.epoch) : null;
    if (allowed !== null) {
      if (allowed !== epoch) fail('state-mismatch');
      return;
    }
    const reg = ensureRegistry(f, kid, self);
    const winner = resetWinner(contenders(readAllStates(f, kid), self), new Set(forgetOrder(reg.entries).keys()));
    if (winner && !(winner.restore === true && winner.notice.epoch === epoch)) fail('state-mismatch');
  };

  const appendJournal = async (r: AppendJournalRequest): Promise<AppendJournalResult> => {
    const { folder: f, kid: localKid, self, own: o } = requireWritable();
    if (!isEpochId(r.epoch) || !isFileNumber(r.segment) || !isCount(r.expectRecords) || !isPositive(r.sv) || !Array.isArray(r.records)) fail('bad-name');
    refuseFrozenEpoch(f, self, r.epoch);
    refuseEpochOpen(f, localKid, self, o, r.epoch);
    const kid = kidFor(r.epoch, localKid);
    const toNext = isNextEpoch(r.epoch);
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
    checkBudget(lines.length, toNext);

    const dir = epochDirOf(f, self, r.epoch);
    let file = dir.segments.get(r.segment);
    if (!file) {
      file = { header: { f: 'ct-j', sm: SYNC_FORMAT_MAJOR, kid, dev: self, e: r.epoch, n: r.segment }, lines: [], partialTail: false, availability: 'local', extraBytes: 0 };
      dir.segments.set(r.segment, file);
    }
    const firstRecord = file.lines.length;
    file.lines.push(...lines);
    addSealed(lines.length, toNext);
    // Y-TECH-02 (§21 point 2) : un ajout qui ouvre un segment plus grand dans la même époque ferme le segment de la tête, avec ce que
    // l'état a pu en annoncer (`o.record`, jamais le nombre de lignes du fichier) ; une nouvelle époque repart d'une liste vide.
    if (sameEpoch && r.segment > o.segment && o.record > 0 && o.segment >= 1) closeSegment(o, o.segment, o.record);
    if (!sameEpoch) o.closed = [];
    o.epoch = r.epoch;
    o.segment = r.segment;
    o.record = file.lines.length;
    o.maxHlc = r.maxHlc;
    return { firstRecord, head: { segment: o.segment, record: o.record } };
  };

  const writeState = async (r: { readonly sv: number; readonly state: PublishedDeviceState }): Promise<void> => {
    const { folder: f, kid, self, own: o } = requireWritable();
    // Rust est maître de `pairedBy` (Y-06) : omis par le moteur, il est complété depuis `own.json` ; une valeur différente est refusée.
    const paired: PublishedDeviceState = r.state.pairedBy === undefined && o.pairedBy !== null ? { ...r.state, pairedBy: o.pairedBy } : r.state;
    if (!isPositive(r.sv)) fail('bad-name');
    if (paired.acks.size > MAX_STATE_ACKS || paired.forgotten.length > MAX_STATE_FORGOTTEN) fail('too-large');
    // Y-10 : Rust est maître de `forgotten` (liste de `forgotten.json`, ou son préfixe complété) ; toute autre liste est refusée.
    const forgotten = completedForgotten(paired.forgotten, ensureRegistry(f, kid, self).entries);
    if (forgotten === null) return fail('state-mismatch');
    // Y-TECH-02 (§21 point 2) : Rust est maître de `closed` : omis → complété depuis own.json (même époque) ; fourni → égal, sinon refus.
    const ownClosed = paired.epoch === o.epoch ? o.closed : [];
    const given = paired.closed ?? [];
    if (given.length > 0 && JSON.stringify(given) !== JSON.stringify(ownClosed)) fail('state-mismatch');
    const withoutClosed = omitKey(paired, 'closed');
    const s: PublishedDeviceState = { ...withoutClosed, forgotten, ...(ownClosed.length > 0 ? { closed: ownClosed.map((c) => ({ ...c })) } : {}) };
    if (s.forgotten.length > MAX_STATE_FORGOTTEN) fail('too-large');
    const text = JSON.stringify(publishedStateToJson(s));
    if (utf8Bytes(text) > MAX_RECORD_PLAINTEXT_BYTES) fail('too-large');
    // État mal formé (sm ou sv à 0, hlc invalide, clé en trop…) : paramètre invalide, `bad-name` (avenant « Amorce »).
    if (!publishedStateFromJson(JSON.parse(text))) fail('bad-name');
    if (s.deviceId !== self || s.platform !== devicePlatform || s.sm !== SYNC_FORMAT_MAJOR || s.sv !== r.sv) fail('state-mismatch');
    refuseEpochOpen(f, kid, self, o, s.epoch);
    // Y-11 : Rust est maître de `reset` (annonce sous l'ancienne clé pour l'appareil qui réinitialise, nul partout ailleurs ; aucune donnée
    // de l'époque visée avant l'annonce) ; `forgotten` comparé ci-dessus (Y-10).
    const record = loadReset(f, self);
    const active = record && record.superseded === null ? record : null;
    const toNext = isNextEpoch(s.epoch);
    if (toNext) {
      if (s.reset !== null || (active?.role === 'initiator' && stageRank(active.stage) < stageRank('announced'))) fail('state-mismatch');
    } else {
      const expected = active?.role === 'initiator' ? active.notice : null;
      if (!sameNotice(s.reset, expected) || active?.role === 'joined') fail('state-mismatch');
    }
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
    checkBudget(1, toNext);
    f.addDeviceFolder(self);
    const dir = f.devices.get(self);
    if (!dir) return fail('io');
    const line = makeLine(text, SYNC_FORMAT_MAJOR, r.sv);
    const file: MemFile = { header: { f: 'ct-state', sm: SYNC_FORMAT_MAJOR, kid: kidFor(s.epoch, kid), dev: self, e: s.epoch, n: s.stateSeq }, lines: [line], partialTail: false, availability: 'local', extraBytes: 0 };
    // Y-11 : l'état de l'époque visée va dans `state.next.ctx`, sous la nouvelle clé (§14.3 étape 4).
    if (toNext) dir.nextState = file;
    else dir.state = file;
    addSealed(1, toNext);
    if (active?.role === 'initiator') {
      if (!toNext) active.kState = { seq: s.stateSeq, digest: text };
      if (!toNext && active.stage === 'created' && s.reset !== null) {
        active.stage = 'announced';
        active.base = { epoch: s.epoch, segment: s.head.segment, record: s.head.record, maxHlc: s.head.hlc };
        active.noticeSeq = s.stateSeq;
      }
      if (toNext && active.stage === 'announced' && s.snapshot !== null) active.stage = 'opened';
    }
    if (s.epoch !== o.epoch) {
      o.epoch = s.epoch;
      o.segment = 0;
      o.record = 0;
      o.maxHlc = null;
      o.closed = [];
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
    const { folder: f, kid: localKid, self, own: o } = requireWritable();
    if (!isEpochId(r.epoch) || !isFileNumber(r.seq) || !isPositive(r.sv)) fail('bad-name');
    refuseFrozenEpoch(f, self, r.epoch);
    refuseEpochOpen(f, localKid, self, o, r.epoch);
    const kid = kidFor(r.epoch, localKid);
    const toNext = isNextEpoch(r.epoch);
    checkEpochNotOlder(o, r.epoch);
    const existing = f.devices.get(self)?.epochs.get(r.epoch);
    // Numéro d'instantané jamais réutilisé dans une époque (choix conservateur, code le plus proche).
    if (existing && r.seq <= maxKey(existing.snapshots)) fail('segment-mismatch');
    // Même époque et même numéro resté ouvert (pages coupées par l'appelant) : abandonné au lieu d'un refus à chaque cycle (revue).
    for (const [id, w] of openWriters) if (w.epoch === r.epoch && w.seq === r.seq) openWriters.delete(id);
    while (openWriters.size >= MAX_OPEN_SNAPSHOTS) openWriters.delete(Math.min(...openWriters.keys()));
    nextWriter += 1;
    const handle = nextWriter;
    openWriters.set(handle, { epoch: r.epoch, seq: r.seq });
    const header: FileHeader = { f: 'ct-s', sm: SYNC_FORMAT_MAJOR, kid, dev: self, e: r.epoch, n: r.seq };
    const lines: MemLine[] = [];
    let bytes = headerBytes(header);
    // Pages fournies par l'appelant : une erreur de sa part (cycle interrompu) laisse l'écrivain ouvert, comme dans Rust (aucun appel).
    const pages = r.records[Symbol.asyncIterator]();
    for (;;) {
      const next = await pages.next();
      if (next.done === true) break;
      // sync_snapshot_append : le fichier `.tmp` est abandonné à la première erreur.
      try {
        for (const text of next.value) {
          if (typeof text !== 'string' || utf8Bytes(text) > MAX_RECORD_PLAINTEXT_BYTES) fail('too-large');
          const line = makeLine(text, SYNC_FORMAT_MAJOR, r.sv);
          bytes += line.bytes;
          if (bytes > MAX_SNAPSHOT_BYTES) fail('too-large');
          lines.push(line);
        }
        checkBudget(lines.length, toNext);
      } catch (error) {
        openWriters.delete(handle);
        throw error;
      }
    }
    // sync_snapshot_commit : renommage atomique.
    openWriters.delete(handle);
    epochDirOf(f, self, r.epoch).snapshots.set(r.seq, { header, lines, partialTail: false, availability: 'local', extraBytes: 0 });
    addSealed(lines.length, toNext);
  };

  const deleteOwn = async (files: readonly OwnFileRef[]): Promise<number> => {
    const { folder: f, self, own: o } = requireWritable();
    // Y-11 : l'époque de l'annonce n'est supprimée que par la bascule (si la réinitialisation perd, own.json y revient).
    const baseEpoch = (() => {
      const record = loadReset(f, self);
      return record && record.superseded === null ? (record.base?.epoch ?? null) : null;
    })();
    if (baseEpoch !== null && files.some((ref) => ref.epoch === baseEpoch)) fail('state-mismatch');
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
    // Y-TECH-02 : l'entrée `closed` d'un segment supprimé de l'époque courante est retirée (partie avec la réécriture suivante).
    const gone = new Set(files.filter((ref) => ref.epoch === o.epoch && ref.kind === 'j').map((ref) => ref.n));
    o.closed = o.closed.filter((c) => !gone.has(c.segment));
    return deleted;
  };

  // --- oubli d'un appareil (Y-10, forget.rs ; ADR 0011 §18 points 3 à 10) --------------------------------------------------------

  /** Registre lu : absent (aucun, autre dossier, autre identité) → null ; illisible (crochet de test) → `io`. */
  const loadRegistry = (f: MemorySyncFolder, self: DeviceId): MemRegistry | null => {
    if (registryCorrupt) return fail('io');
    return registry && registry.folderId === f.id && registry.deviceId === self ? registry : null;
  };

  /** États de tous les dossiers d'appareils (sans plafond de 16) ; chaque état authentifié lu est retenu par l'anti-rejeu (Y-TECH-01, même règle que `read_all_states` de Rust). */
  const readAllStates = (f: MemorySyncFolder, kid: string): Map<DeviceId, StateRead> => {
    const reads = new Map<DeviceId, StateRead>();
    for (const [name, dir] of f.devices) if (isSyncDeviceId(name)) reads.set(name, readState(name, dir, kid, true));
    return reads;
  };

  const okStates = (reads: ReadonlyMap<DeviceId, StateRead>): [DeviceId, PublishedDeviceState][] =>
    [...reads].filter(([, r]) => r.status === 'ok' && r.state !== null).map(([id, r]) => [id, r.state as PublishedDeviceState]);

  /** Reconstruction (§18 point 7, cas (i), (ii), (iii)), sinon `cloud-pending`, `newer-format` ou `state-mismatch`. */
  const rebuildRegistry = (f: MemorySyncFolder, kid: string, self: DeviceId): MemRegistry => {
    const reads = readAllStates(f, kid);
    const ok = okStates(reads);
    const { entries } = learnDeclarations([], ok.flatMap(([, s]) => s.forgotten));
    const order = forgetOrder(entries);
    const acksOnSelf = ok.filter(([id]) => id !== self && !order.has(id)).flatMap(([, s]) => (s.acks.has(self) ? [(s.acks.get(self) as DeviceAck).stateSeq] : []));
    const status = reads.get(self)?.status ?? 'missing';
    const dir = f.devices.get(self);
    const neverPublished = (!dir || (dir.state === null && dir.epochs.size === 0 && dir.strays === 0)) && !ok.some(([, s]) => s.acks.has(self));
    const ownValid = own !== null && own.folderId === f.id && own.kid === kid ? own : null;
    let allowed: boolean;
    switch (status) {
      case 'ok':
        allowed = true;
        break;
      case 'cloud-pending':
        return fail('cloud-pending');
      case 'newer-format':
        return fail('newer-format');
      default:
        allowed = (status === 'missing' && neverPublished) || (ownValid !== null && acksOnSelf.some((seq) => seq >= ownValid.stateSeq));
    }
    if (!allowed) return fail('state-mismatch');
    return withSelfForgotten({ folderId: f.id, deviceId: self, entries, done: [], selfForgotten: null });
  };

  /** Registre valide pour le dossier et l'appareil liés : lu, sinon reconstruit et gardé avant toute écriture. */
  const ensureRegistry = (f: MemorySyncFolder, kid: string, self: DeviceId): MemRegistry => {
    const found = loadRegistry(f, self);
    if (found) return found;
    registry = rebuildRegistry(f, kid, self);
    return registry;
  };

  /** Entrée `.next` au coffre (nouvelle clé, ou orpheline). */
  const vaultHasNext = (): boolean => resetPending || nextKey !== null;

  /** Suppression des fichiers d'un oublié : refusée pendant toute réinitialisation (Y-10 condition (b)). */
  const resetInProgress = (reads: ReadonlyMap<DeviceId, StateRead>): boolean => vaultHasNext() || okStates(reads).some(([, s]) => s.reset !== null);

  /**
   * Y-11 (§18 points 14 et 15) : pendant une réinitialisation (registre, entrée `.next`, annonce lue), l'oubli n'est permis qu'à
   * l'appareil qui réinitialise (bascule pas commencée), ou quand la cible est l'auteur d'une annonce (lue sous la clé locale, valide ou
   * non ; auteur de la réinitialisation rejointe ; gagnant d'une perte). Même règle que `reset_blocks_forget` de Rust.
   */
  const resetBlocksForget = (f: MemorySyncFolder, self: DeviceId, reads: ReadonlyMap<DeviceId, StateRead>, target: DeviceId): boolean => {
    const record = loadReset(f, self);
    const announcers = new Set<DeviceId>(okStates(reads).filter(([id, s]) => id !== self && s.reset !== null).map(([id]) => id));
    if (record === null && announcers.size === 0 && !vaultHasNext()) return false;
    if (record !== null && record.superseded === null && record.role === 'initiator' && record.switchStep === 0) return false;
    if (record !== null) {
      if (record.by !== self) announcers.add(record.by);
      if (record.superseded?.by) announcers.add(record.superseded.by);
    }
    return !announcers.has(target);
  };

  const forgetContext = (): { readonly f: MemorySyncFolder; readonly kid: string; readonly self: DeviceId } => {
    const f = requireFolder();
    const k = requireKey();
    const self = requireBound();
    refuseIfSelfForgotten(f, self);
    return { f, kid: k.kid, self };
  };

  /** Contrôles de `sync_device_forget` (avant et après la boîte) ; null : déjà oublié (sans boîte). */
  const forgetDeclaration = (deviceId: DeviceId): ForgottenDevice[] | null => {
    const { f, kid, self } = forgetContext();
    if (deviceId === self) return fail('bad-name');
    const reg = ensureRegistry(f, kid, self);
    const reads = readAllStates(f, kid);
    if (resetBlocksForget(f, self, reads, deviceId)) return fail('state-mismatch');
    const order = forgetOrder(reg.entries);
    if (order.has(self)) return fail('state-mismatch');
    if (order.has(deviceId)) return null;
    const ok = okStates(reads);
    const actives = ok.filter(([id]) => !order.has(id)).map(([, s]) => s);
    const cited = citedDevices(actives);
    const known = reads.has(deviceId) || cited.has(deviceId) || accepted.has(deviceId) || reg.entries.some((e) => e.deviceId === deviceId);
    if (!known) return fail('bad-name');
    if (reg.entries.length >= FORGET_DECLARE_LIMIT) return fail('too-large');
    const seen = actives.filter((s) => s.deviceId !== deviceId).flatMap(stateHlcs);
    const at = declarationHlc(now(), seen, self, PAIRING_CLOCK_TOLERANCE_MS);
    if (at === null) return fail('hlc-order');
    const ownState = ok.find(([id]) => id === self)?.[1] ?? null;
    return [...reg.entries, { deviceId, at, lastAck: ownState?.acks.get(deviceId) ?? null }];
  };

  const deviceForget = async (deviceId: DeviceId): Promise<void> => {
    if (!isSyncDeviceId(deviceId)) return fail('bad-name');
    if (forgetDeclaration(deviceId) === null) return;
    // Confirmation native : mêmes préconditions, compteur persisté (3 ouvertures par 10 minutes) et blocage que Y-08.
    gate();
    forgetOpenings = prune(forgetOpenings);
    if (forgetOpenings.length >= CONSENT_MAX_SHOW) fail('rate-limited');
    forgetOpenings.push(now());
    askConsent();
    const entries = forgetDeclaration(deviceId);
    if (entries === null || registry === null) return;
    registry = { ...registry, entries };
  };

  /** `sync_forgotten_delete` : conditions recalculées depuis le dossier et le registre, puis suppression des seuls fichiers de `devices/<id>/`. */
  const forgottenDelete = async (deviceId: DeviceId): Promise<ForgottenDeleteResult> => {
    if (!isSyncDeviceId(deviceId)) return fail('bad-name');
    const { f, kid, self } = forgetContext();
    if (deviceId === self) return fail('bad-name');
    const reg = ensureRegistry(f, kid, self);
    const reads = readAllStates(f, kid);
    if (resetInProgress(reads)) return fail('state-mismatch');
    const ok = okStates(reads);
    const seen = seenDevices(accepted.keys() as Iterable<DeviceId>, ok.map(([, s]) => s), reg.entries);
    const ids = new Set<DeviceId>([...reads.keys(), ...seen, ...reg.entries.map((e) => e.deviceId)]);
    const known: ForgetKnownDevice[] = [...ids].map((id) => {
      const read = reads.get(id);
      const status = read?.status ?? 'missing';
      return { deviceId: id, status, state: status === 'ok' ? (read?.state ?? null) : null, seen: seen.has(id) };
    });
    const check = forgottenDeleteCheck(deviceId, self, reg.entries, reg.done, known, ownSnapshotEnd(f, self, reads.get(self)));
    if (check.kind !== 'ready') return fail(check.code);
    const result = deleteDeviceFiles(f, deviceId);
    if (result.complete && !reg.done.includes(deviceId)) registry = { ...reg, done: [...reg.done, deviceId] };
    return result;
  };

  /** Condition (h) (§18 point 11) : fin de l'instantané annoncé par son propre état authentifié, lue comme `tail`. */
  const ownSnapshotEnd = (f: MemorySyncFolder, self: DeviceId, read: StateRead | undefined): SnapshotEndRead => {
    const state = read?.status === 'ok' ? read.state : null;
    if (!state?.snapshot) return 'none';
    const file = f.devices.get(self)?.epochs.get(state.epoch)?.snapshots.get(state.snapshot.seq);
    if (!file || !hydrated(file)) return 'cloud-pending';
    const last = file.lines[file.lines.length - 1];
    if (file.partialTail || !last) return 'cloud-pending';
    const end = last.corrupt ? null : parseSnapshotRecord(last.text);
    if (!end || end.k !== 'snap-end' || end.epoch !== state.epoch) return 'unreadable';
    return { author: self, epoch: state.epoch, seq: state.snapshot.seq, endHlc: state.snapshot.endHlc, covers: end.covers };
  };

  /** Seuls les noms stricts (en mémoire : segments, instantanés, dossiers d'époque, état), `state.ctx` en dernier. */
  const deleteDeviceFiles = (f: MemorySyncFolder, deviceId: DeviceId): ForgottenDeleteResult => {
    const dir = f.devices.get(deviceId);
    if (!dir) return { deleted: 0, complete: true };
    let deleted = 0;
    for (const [epoch, epochDir] of [...dir.epochs]) {
      for (const map of [epochDir.segments, epochDir.snapshots]) {
        for (const n of [...map.keys()]) {
          if (deleted >= MAX_FORGOTTEN_DELETE_ENTRIES) return { deleted, complete: false };
          map.delete(n);
          deleted += 1;
        }
      }
      if (deleted >= MAX_FORGOTTEN_DELETE_ENTRIES) return { deleted, complete: false };
      dir.epochs.delete(epoch);
      deleted += 1;
    }
    if (dir.state) {
      if (deleted >= MAX_FORGOTTEN_DELETE_ENTRIES) return { deleted, complete: false };
      dir.state = null;
      deleted += 1;
    }
    // Noms étrangers : jamais supprimés, le dossier reste.
    if (dir.strays === 0) f.devices.delete(deviceId);
    return { deleted, complete: true };
  };

  // --- clé et appairage ---------------------------------------------------------------------------------------------------------

  const folderHasData =(f: MemorySyncFolder): boolean =>
    [...f.devices].some(([name, dir]) => isSyncDeviceId(name) && (dir.state !== null || [...dir.epochs.values()].some((e) => e.segments.size + e.snapshots.size > 0)));

  /** États lisibles et `kid` qu'ils portent ; Y-11 : `state.next.ctx` compris, et plus grande époque d'un état de chaque `kid`. */
  const folderKids = (f: MemorySyncFolder, only: DeviceId | null): { readonly readable: number; readonly kids: Set<string>; readonly epochs: Map<string, EpochId> } => {
    let readable = 0;
    const kids = new Set<string>();
    const epochs = new Map<string, EpochId>();
    for (const [name, dir] of f.devices) {
      if (!isSyncDeviceId(name) || (only !== null && name !== only)) continue;
      for (const file of [dir.state, dir.nextState]) {
        if (!file || file.availability !== 'local' || file.header.f !== 'ct-state') continue;
        readable += 1;
        if (file.lines.length !== 1 || file.lines[0]?.corrupt === true || file.partialTail) continue;
        kids.add(file.header.kid);
        const known = epochs.get(file.header.kid);
        if (isEpochId(file.header.e) && (known === undefined || compareEpochs(file.header.e, known) > 0)) epochs.set(file.header.kid, file.header.e);
      }
    }
    return { readable, kids, epochs };
  };

  /** Annonces lues dans les états authentifiés des autres appareils. */
  const announcements = (reads: ReadonlyMap<DeviceId, StateRead>, self: DeviceId): ResetCandidate[] =>
    okStates(reads)
      .filter(([id, s]) => id !== self && s.reset !== null)
      .map(([id, s]) => ({ by: id, stateEpoch: s.epoch, notice: s.reset as ResetNotice }));

  /** Concurrents (§18 point 16) : annonces des autres appareils et époques ouvertes sous la clé locale (soi compris). */
  const contenders = (reads: ReadonlyMap<DeviceId, StateRead>, self: DeviceId): ResetCandidate[] => {
    const out = announcements(reads, self);
    const opened: OpenedEpoch[] = okStates(reads).map(([id, s]) => ({ by: id, epoch: s.epoch, snapshot: s.snapshot !== null, notice: s.reset !== null }));
    return [...out, ...restoreCandidates(opened, out)];
  };

  /**
   * Y-11 (D1) : l'ancienne clé ne doit plus être donnée (perte non réassociée, ou annonce valide d'un autre appareil qui l'emporte).
   * Échoue fermé (audit 6) : registre illisible, état d'un autre appareil en attente d'iCloud (`cloud-pending`).
   */
  const oldKeyWithdrawn = (f: MemorySyncFolder, kid: string, self: DeviceId): boolean => {
    const lost = loadReset(f, self)?.superseded;
    if (lost?.epoch && !lost.restore) return true;
    const entries = ensureRegistry(f, kid, self).entries;
    const reads = readAllStates(f, kid);
    const forgotten = new Set<string>(forgetOrder(entries).keys());
    // Seconde revue, point 2 : seul un actif (ni oublié, ni expiré d'après le dernier scan) dont l'état attend iCloud bloque.
    const expired = (id: string): boolean => {
      const ms = lastSeen.get(id);
      return ms !== undefined && ms + DEVICE_EXPIRY_MS < now();
    };
    if ([...reads].some(([id, r]) => id !== self && r.status === 'cloud-pending' && !forgotten.has(id) && !expired(id))) fail('cloud-pending');
    const winner = resetWinner(contenders(reads, self), forgotten as Set<DeviceId>);
    return winner !== null && winner.restore !== true;
  };

  /** Annonces égales (ou toutes deux nulles). */
  const sameNotice = (a: ResetNotice | null, b: ResetNotice | null): boolean => (a === null || b === null ? a === b : a.kid === b.kid && a.epoch === b.epoch && a.at === b.at);

  /** Époque courante vue par Rust : la plus grande annoncée par un état authentifié d'un appareil non oublié. */
  const currentEpoch = (reads: ReadonlyMap<DeviceId, StateRead>, order: ReadonlyMap<DeviceId, unknown>): EpochId | null =>
    okStates(reads)
      .filter(([id]) => !order.has(id))
      .map(([, s]) => s.epoch)
      .reduce<EpochId | null>((best, e) => (best === null || compareEpochs(e, best) > 0 ? e : best), null);

  /** Appareils connus (dossiers, vus, cibles de la liste maître), vus, auteurs d'une déclaration. */
  const knownIds = (reads: ReadonlyMap<DeviceId, StateRead>, entries: readonly ForgottenDevice[]): { ids: Set<DeviceId>; seen: Set<DeviceId>; authors: Set<DeviceId> } => {
    const seen = new Set(seenDevices(accepted.keys() as Iterable<DeviceId>, okStates(reads).map(([, s]) => s), entries));
    const authors = new Set(entries.flatMap((e) => {
      const author = declarationAuthor(e);
      return author ? [author] : [];
    }));
    return { ids: new Set<DeviceId>([...reads.keys(), ...seen, ...entries.map((e) => e.deviceId)]), seen, authors };
  };

  /** Contrôles de `sync_reset_key` (avant et après la boîte) : reprise, ou plan de création ; sinon refus sans rien écrire. */
  const resetPlan = (): { readonly resume: string } | { readonly epoch: EpochId; readonly at: Hlc; readonly noticeEpoch: EpochId; readonly self: DeviceId; readonly f: MemorySyncFolder } => {
    const { f, kid, self } = forgetContext();
    const reg = ensureRegistry(f, kid, self);
    const record = loadReset(f, self);
    if (record && record.superseded === null && record.role === 'initiator') {
      if (nextKey && nextKey.kid === record.kid) return { resume: record.kid };
      return fail('state-mismatch');
    }
    if (record && record.superseded === null) return fail('state-mismatch');
    if (record?.superseded?.epoch && !record.superseded.restore) return fail('state-mismatch');
    const reads = readAllStates(f, kid);
    const order = forgetOrder(reg.entries);
    const forgotten = new Set(order.keys());
    const winner = resetWinner(contenders(reads, self), forgotten);
    if (winner && winner.restore !== true) return fail('state-mismatch');
    const own = reads.get(self);
    if (own?.status !== 'ok' || !own.state) return fail('state-mismatch');
    const { ids, seen, authors } = knownIds(reads, reg.entries);
    const live = okStates(reads).filter(([id]) => !order.has(id)).map(([, s]) => s);
    const actives: ResetPreconditionDevice[] = [...ids]
      .filter((id) => id !== self && !order.has(id))
      .map((id) => {
        const read = reads.get(id);
        const status = read?.status ?? 'missing';
        const state = status === 'ok' ? (read?.state ?? null) : null;
        return {
          deviceId: id,
          status,
          head: state?.head ?? null,
          expired: state !== null && hlcMs(state.lastSyncHlc) + DEVICE_EXPIRY_MS < now(),
          phantom: status !== 'ok' && !seen.has(id) && !authors.has(id),
        };
      });
    const cuts = [...order.keys()].map((target) => ({ deviceId: target, cutoff: cutoff(target, live) }));
    if (resetPrecondition(actives, cuts, own.state.acks)) return fail('state-mismatch');
    const current = currentEpoch(reads, order);
    const base = current !== null && compareEpochs(current, own.state.epoch) > 0 ? current : own.state.epoch;
    const n = parseEpochId(base)?.n ?? 0;
    if (n >= 9_999) return fail('too-large');
    const at = declarationHlc(now(), live.flatMap(stateHlcs), self, PAIRING_CLOCK_TOLERANCE_MS);
    if (at === null) return fail('hlc-order');
    return { epoch: `e${String(n + 1).padStart(4, '0')}-${self}` as EpochId, at, noticeEpoch: own.state.epoch, self, f };
  };

  /** `sync_reset_key` : refus avant la boîte, reprise (même K2, sans boîte), confirmation native, K2 sous `.next` et registre. */
  const resetStart = async (): Promise<{ readonly kid: string }> => {
    const first = resetPlan();
    if ('resume' in first) return { kid: first.resume };
    gate();
    resetOpenings = prune(resetOpenings);
    if (resetOpenings.length >= CONSENT_MAX_SHOW) fail('rate-limited');
    resetOpenings.push(now());
    askConsent();
    const plan = resetPlan();
    if ('resume' in plan) return { kid: plan.resume };
    // Une entrée `.next` orpheline (arrêt entre la clé et le registre) est reprise, jamais remplacée.
    if (!nextKey) {
      const raw = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
      nextKey = { raw, kid: await kidOf(raw) };
    }
    const kid = nextKey.kid;
    resetRecord = {
      folderId: plan.f.id,
      deviceId: plan.self,
      role: 'initiator',
      kid,
      epoch: plan.epoch,
      by: plan.self,
      notice: { kid, epoch: plan.epoch, at: plan.at },
      noticeEpoch: plan.noticeEpoch,
      noticeSeq: null,
      kState: null,
      authorAtImport: null,
      stage: 'created',
      base: null,
      superseded: null,
      switchStep: 0,
    };
    sealedNext = 0;
    return { kid };
  };

  /** Import d'une autre clé par un appareil associé (Y-11) : null (import ordinaire), registre `joined`, ou `already`. */
  const joinPlan = (f: MemorySyncFolder, localKid: string, candidateKid: string, epoch: EpochId | undefined): MemResetRecord | 'already' | null => {
    if (bound === null) return null;
    const record = loadReset(f, bound);
    if (record && record.superseded === null) {
      if (record.kid === candidateKid) return 'already';
      return fail('state-mismatch');
    }
    // Audit 2 : appartenance sur des preuves locales (son état, own.json lié au dossier et à l'ancienne clé, anti-rejeu de soi,
    // fichiers déjà publiés) ; son état en attente d'iCloud : `cloud-pending`.
    const dir = f.devices.get(bound);
    const mine = dir ? readStateFile(bound, dir, 'state', [localKid], false, false) : null;
    if (mine?.status === 'cloud-pending') return fail('cloud-pending');
    const ownProof = own !== null && own.folderId === f.id && own.kid === localKid && (own.stateSeq > 0 || own.epoch !== null) ? own : null;
    const published = dir !== undefined && (dir.state !== null || dir.epochs.size > 0);
    const member = mine?.status === 'ok' || mine?.status === 'rollback' || record !== null || ownProof !== null || accepted.has(bound) || published;
    if (!member) return null;
    if (epoch === undefined) return fail('key-mismatch');
    // Revue 2 : l'époque lue avec la clé candidate doit dépasser l'époque courante de cet appareil.
    const current = [ownProof?.epoch ?? null, mine?.status === 'ok' ? (mine.state?.epoch ?? null) : null].reduce<EpochId | null>((best, e) => (e !== null && (best === null || compareEpochs(e, best) > 0) ? e : best), null);
    if (current !== null && compareEpochs(epoch, current) <= 0) return fail('key-mismatch');
    const by = parseEpochId(epoch)?.opener as DeviceId;
    const byDir = f.devices.get(by);
    const announced = byDir ? readStateFile(by, byDir, 'state', [localKid], false, false) : null;
    const notice = announced?.status === 'ok' && announced.state?.reset?.kid === candidateKid && announced.state.reset.epoch === epoch ? announced.state.reset : null;
    if (!own || own.folderId !== f.id || own.kid !== localKid) own = rebuildOwn(f, localKid, bound);
    const line = dir?.state?.lines[0];
    return {
      folderId: f.id,
      deviceId: bound,
      role: 'joined',
      kid: candidateKid,
      epoch,
      by,
      notice,
      noticeEpoch: notice ? (announced?.state?.epoch ?? null) : null,
      noticeSeq: notice ? (announced?.state?.stateSeq ?? null) : null,
      kState: mine?.status === 'ok' && mine.state && line ? { seq: mine.state.stateSeq, digest: line.text } : null,
      authorAtImport: announced?.status === 'ok' && announced.state ? { seq: announced.state.stateSeq, epoch: announced.state.epoch } : null,
      stage: 'opened',
      base: { epoch: own.epoch, segment: own.segment, record: own.record, maxHlc: own.maxHlc },
      superseded: null,
      switchStep: 0,
    };
  };

  const viewOf = (record: MemResetRecord, waiting: readonly DeviceId[], switched: boolean, resumed: boolean, closed = false): ResetView => ({
    role: record.role,
    kid: record.kid,
    epoch: record.epoch,
    by: record.by,
    notice: record.role === 'initiator' && record.superseded === null ? record.notice : null,
    stage: record.stage,
    noticeEpoch: record.noticeEpoch,
    closed,
    superseded: record.superseded ? { epoch: record.superseded.epoch, by: record.superseded.by, restore: record.superseded.restore } : null,
    switching: record.switchStep > 0 && !switched,
    switched,
    resumed,
    waiting,
  });

  /** Étapes du perdant (§18 point 2), idempotentes : `state.next.ctx` supprimé, `.next` effacée, own.json ramené à l'époque `n`. */
  const supersedeSteps = (f: MemorySyncFolder, record: MemResetRecord): void => {
    interrupt('supersede-2');
    const dir = f.devices.get(record.deviceId);
    if (dir) dir.nextState = null;
    // Son état publié redevient celui de l'ancienne clé : l'anti-rejeu de cet appareil seul y revient, s'il est bien le sien (même règle
    // que `own_state_back` de Rust).
    const k0 = key;
    const mine = dir && k0 ? readStateFile(record.deviceId, dir, 'state', [k0.kid], false, false) : null;
    const line = dir?.state?.lines[0];
    if (mine?.status === 'ok' && mine.state && line) {
      // Audit 5 : seule exception à l'anti-rejeu, le dernier état écrit sous l'ancienne clé (même stateSeq, même contenu), base exigée.
      const ours = record.base !== null && record.kState !== null && record.kState.seq === mine.state.stateSeq && record.kState.digest === line.text;
      if (ours) accepted.set(record.deviceId, { epoch: mine.state.epoch, seq: mine.state.stateSeq, digest: line.text, head: mine.state.head });
    }
    interrupt('supersede-3');
    if (nextKey?.kid === record.kid) nextKey = null;
    sealedNext = 0;
    interrupt('supersede-4');
    const k = key;
    if (record.base && own && k && own.folderId === f.id && own.kid === k.kid && own.epoch !== record.base.epoch) {
      own.epoch = record.base.epoch;
      own.segment = record.base.segment;
      own.record = record.base.record;
      own.maxHlc = record.base.maxHlc;
      own.closed = [];
    }
    if (record.superseded) record.superseded.done = true;
  };

  /** Bascule (§14.3 étape 5), étapes mémorisées : état K2 sous `state.ctx`, `state.next.ctx` supprimé, anciennes époques supprimées, K2 sous `.v1`, `.next` effacée, registre supprimé. */
  const finishSwitch = (f: MemorySyncFolder, record: MemResetRecord): void => {
    const dir = f.devices.get(record.deviceId);
    if (record.switchStep < 1) {
      interrupt('switch-1');
      if (!dir?.nextState || dir.nextState.header.kid !== record.kid) return fail('state-mismatch');
      dir.state = cloneFile(dir.nextState);
      record.switchStep = 1;
    }
    // Audit 3 et audit bas de la seconde revue : avant d'effacer quoi que ce soit (étapes 2 à 5, dès la suppression de state.next.ctx),
    // son `state.ctx` doit être sous la nouvelle clé dans l'époque visée.
    if (record.switchStep < 5) {
      const state = dir?.state;
      const read = state && dir ? readStateFile(record.deviceId, dir, 'state', [record.kid], false, false) : null;
      if (read?.status !== 'ok' || read.state?.epoch !== record.epoch) return fail('state-mismatch');
    }
    if (record.switchStep < 2) {
      interrupt('switch-2');
      if (dir) dir.nextState = null;
      record.switchStep = 2;
    }
    if (record.switchStep < 3) {
      interrupt('switch-3');
      for (const epoch of [...(dir?.epochs.keys() ?? [])]) if (compareEpochs(epoch, record.epoch) < 0) dir?.epochs.delete(epoch);
      record.switchStep = 3;
    }
    if (record.switchStep < 4) {
      interrupt('switch-4');
      const next = nextKey && nextKey.kid === record.kid ? nextKey : key && key.kid === record.kid ? key : null;
      if (!next) return fail('vault-unavailable');
      key = next;
      if (own && own.folderId === f.id) own = { ...own, kid: record.kid };
      sealed = sealedNext;
      record.switchStep = 4;
    }
    if (record.switchStep < 5) {
      interrupt('switch-5');
      nextKey = null;
      record.switchStep = 5;
    }
    interrupt('switch-6');
    resetRecord = null;
    record.switchStep = 6;
  };

  /**
   * Oubliés retenus que l'instantané annoncé dans son `state.next.ctx` ne couvre pas (§18 point 14, `uncovered_forgotten` de Rust) :
   * coupure sur les accusés de chaque actif non oublié, lus dans son état présenté et dans son `state.ctx` sous l'ancienne clé.
   */
  const uncoveredForgotten = (f: MemorySyncFolder, record: MemResetRecord, reads: ReadonlyMap<DeviceId, StateRead>, mine: StateRead | undefined, entries: readonly ForgottenDevice[]): DeviceId[] => {
    const localKid = key?.kid ?? '';
    const raw: Pick<PublishedDeviceState, 'deviceId' | 'acks'>[] = [];
    // Époque la plus récente où chaque appareil a publié un état : un accusé au-delà ne désigne rien (seconde revue, bloquant).
    const published = new Map<DeviceId, EpochId>();
    const note = (id: DeviceId, s: PublishedDeviceState): void => {
      const known = published.get(id);
      if (known === undefined || compareEpochs(s.epoch, known) > 0) published.set(id, s.epoch);
    };
    for (const [id, read] of reads) {
      if (read.status === 'ok' && read.state) {
        note(id, read.state);
        raw.push({ deviceId: id, acks: read.state.acks });
      }
      if (read.fromNext === true || read.kid !== localKid) {
        const dir = f.devices.get(id);
        const old = dir ? readStateFile(id, dir, 'state', [localKid], false, false) : null;
        // Remarques finales : anti-rejeu propre à ces relectures sous l'ancienne clé ; un rejeu garde les derniers accusés acceptés.
        const line = dir?.state?.lines[0];
        const current = old?.status === 'ok' && old.state && line ? { epoch: old.state.epoch, seq: old.state.stateSeq, digest: line.text, head: old.state.head } : null;
        const previous = kAccepted.get(id);
        if (old?.state && current && !(previous && isRollback(previous, current))) {
          note(id, old.state);
          kAccepted.set(id, current);
          kAcks.set(id, old.state.acks);
          raw.push({ deviceId: id, acks: old.state.acks });
        } else {
          const kept = kAcks.get(id);
          if (kept) raw.push({ deviceId: id, acks: kept });
        }
      }
    }
    const ackers = raw.map((a) => ({
      deviceId: a.deviceId,
      acks: new Map([...a.acks].filter(([target, ack]) => {
        const p = published.get(target);
        return p === undefined || compareEpochs(ack.epoch, p) <= 0;
      })),
    }));
    const order = forgetOrder(entries);
    const end = ownSnapshotEnd(f, record.deviceId, mine);
    if (typeof end !== 'string') {
      const missing = coversForgotten(end.covers, entries, ackers);
      return missing === null ? [] : [missing];
    }
    const live = ackers.filter((a) => !order.has(a.deviceId));
    return [...order.keys()].filter((target) => cutoff(target, live) !== null);
  };

  /** Passage de la réinitialisation au scan (mêmes règles que `reset_pass` de Rust). */
  const resetPass = (f: MemorySyncFolder, self: DeviceId): ResetView | null => {
    const record = loadReset(f, self);
    if (!record) return null;
    if (record.switchStep > 0) {
      finishSwitch(f, record);
      return viewOf(record, [], true, true);
    }
    if (record.superseded) {
      if (!record.superseded.done) supersedeSteps(f, record);
      // §18 point 16 : perdue face à une restauration et l'époque restaurée suivie : registre clos (rien à associer, K reste la clé).
      const target = record.superseded.epoch;
      if (record.superseded.restore && record.superseded.done && target !== null && own && own.folderId === f.id && own.epoch !== null && compareEpochs(own.epoch, target) >= 0) {
        resetRecord = null;
        return null;
      }
      // §18 point 15 : gagnant oublié : registre clos (les étapes faites ne sont pas défaites), `sync_reset_key` redevient possible.
      const winnerBy = record.superseded.by;
      if (winnerBy !== null && forgetOrder(ensureRegistry(f, requireKey().kid, self).entries).has(winnerBy)) {
        resetRecord = null;
        return viewOf(record, [], false, false, true);
      }
      return viewOf(record, [], false, false);
    }
    const localKid = requireKey().kid;
    if (!nextKey || nextKey.kid !== record.kid) {
      record.superseded = { epoch: null, by: null, done: false, restore: false };
      supersedeSteps(f, record);
      return viewOf(record, [], false, false);
    }
    const reg = ensureRegistry(f, localKid, self);
    const order = forgetOrder(reg.entries);
    const forgotten = new Set(order.keys());
    const reads = readAllStates(f, localKid);
    if (record.role === 'joined' && record.notice === null) {
      const byDir = f.devices.get(record.by);
      const announced = byDir ? readStateFile(record.by, byDir, 'state', [localKid], false, false) : null;
      if (announced?.status === 'ok' && announced.state?.reset?.kid === record.kid && announced.state.reset.epoch === record.epoch) {
        record.notice = announced.state.reset;
        record.noticeEpoch = announced.state.epoch;
        record.noticeSeq = announced.state.stateSeq;
      }
    }
    const ours: ResetCandidate | null = record.notice && record.noticeEpoch ? { by: record.by, stateEpoch: record.noticeEpoch, notice: record.notice } : null;
    const candidates: ResetCandidate[] = [];
    const opened: OpenedEpoch[] = [];
    let authorSwitched = false;
    let authorWithdrew = false;
    let authorSeen = false;
    for (const [id, read] of reads) {
      if (id === self || read.status !== 'ok' || !read.state) continue;
      if (read.kid === record.kid) {
        if (id === record.by) {
          authorSeen = true;
          authorSwitched ||= read.fromNext !== true && read.state.epoch === record.epoch;
          if (ours) candidates.push(ours);
        }
        continue;
      }
      if (read.state.reset) candidates.push({ by: id, stateEpoch: read.state.epoch, notice: read.state.reset });
      opened.push({ by: id, epoch: read.state.epoch, snapshot: read.state.snapshot !== null, notice: read.state.reset !== null });
      if (id === record.by) {
        authorSeen = true;
        // Revue 1 : retrait compté seulement si l'annonce a été vue et que l'état lu est strictement plus récent qu'elle.
        const newerThanNotice = record.notice !== null && record.noticeSeq !== null && read.state.stateSeq > record.noticeSeq;
        // Seconde revue, point 3 : plus récent que l'état de l'auteur lu à l'import, même sans annonce lue.
        const at = record.authorAtImport;
        const newerThanImport = at !== null && (read.state.stateSeq > at.seq || compareEpochs(read.state.epoch, at.epoch) > 0);
        const newer = newerThanNotice || newerThanImport;
        authorWithdrew ||= newer && read.state.reset?.kid !== record.kid;
      }
    }
    if ((record.role === 'initiator' || !authorSeen) && ours) candidates.push(ours);
    // §18 point 16 : les époques ouvertes sous l'ancienne clé (restaurations) concourent avec les annonces.
    candidates.push(...restoreCandidates(opened, ours ? [...candidates, ours] : candidates));
    const winner = resetWinner(candidates, forgotten);
    const lost = !authorSwitched && (winner ? winner.notice.epoch !== record.epoch : record.role === 'joined' && (authorWithdrew || forgotten.has(record.by)));
    if (lost) {
      record.superseded = { epoch: winner?.notice.epoch ?? null, by: winner?.by ?? null, done: false, restore: winner?.restore === true };
      supersedeSteps(f, record);
      return viewOf(record, [], false, false);
    }
    const mine = reads.get(self);
    const ownReady =
      mine?.status === 'ok' && mine.fromNext === true && mine.kid === record.kid && mine.state?.epoch === record.epoch && (record.role === 'joined' || mine.state.snapshot !== null);
    const { ids, seen, authors } = knownIds(reads, reg.entries);
    const known: ResetKnownDevice[] = [...ids].map((id) => {
      const read = reads.get(id);
      const status = read?.status ?? 'missing';
      return { deviceId: id, status, epoch: status === 'ok' ? (read?.state?.epoch ?? null) : null, kid: read?.kid ?? null, seen: seen.has(id), author: authors.has(id) };
    });
    const waiting = record.role === 'initiator' ? resetWaiting(known, self, record.epoch, record.kid, forgotten) : [];
    // §18 point 14 : l'instantané annoncé sous la nouvelle clé doit couvrir chaque oublié retenu (coupure sur les états des deux clés).
    if (record.role === 'initiator' && ownReady && record.stage === 'opened' && waiting.length === 0 && order.size > 0) {
      for (const id of uncoveredForgotten(f, record, reads, mine, reg.entries)) if (!waiting.includes(id)) waiting.push(id);
      waiting.sort();
    }
    const ready = ownReady && (record.role === 'initiator' ? record.stage === 'opened' && waiting.length === 0 : authorSwitched);
    if (!ready) return viewOf(record, waiting, false, false);
    finishSwitch(f, record);
    return viewOf(record, [], true, false);
  };

  const pairingPayload = async (o?: { readonly renew: true }): Promise<PairingPayload> => {
    const instance = livePairing();
    if (!instance) return fail('wrong-window');
    if (instance.mode !== 'show') return fail('wrong-mode');
    const k = requireKey();
    const self = requireBound();
    const f = requireFolder();
    // Y-11 (D1) : pendant une réinitialisation, la nouvelle clé et l'époque visée ; jamais l'ancienne clé après une annonce.
    const next = activeNext();
    if (!next && oldKeyWithdrawn(f, k.kid, self)) return fail('state-mismatch');
    if (o?.renew) {
      openShowConsent();
      instance.generation += 1;
      instance.openedAt = now();
      instance.payloadTaken = false;
    } else if (instance.payloadTaken) {
      // Jeton de consentement à usage unique : un second appel sans « Nouveau code » est refusé.
      return fail('wrong-window');
    }
    const epoch = next ? next.epoch : own && own.folderId === f.id && own.kid === k.kid ? own.epoch : null;
    const raw = next && nextKey ? nextKey.raw : k.raw;
    const expiresAt = instance.openedAt + PAIRING_VALIDITY_MS;
    instance.payloadTaken = true;
    return { qrText: qrTextOf({ key: raw, deviceId: self, epoch, expiresAt }), recoveryKey: await recoveryKeyOf(raw), expiresAt };
  };

  /** §18 point 17 : refus de `sync_key_import` persisté (sauf `wrong-window`, `wrong-mode`, `not-foreground`, `consent-denied`). */
  const importKey = async (input: KeyImportInput): Promise<KeyImportResult> => {
    try {
      const result = await importKeyInner(input);
      importFailure = null;
      return result;
    } catch (error) {
      const code = error instanceof SyncPlatformError ? error.code : 'io';
      if (folder && !['wrong-window', 'wrong-mode', 'not-foreground', 'consent-denied'].includes(code)) {
        importFailure = { folderId: folder.id, code, at: new Date(now()).toISOString(), next: nextKey !== null || resetRecord !== null };
      }
      throw error;
    }
  };

  const importKeyInner = async (input: KeyImportInput): Promise<KeyImportResult> => {
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
      // ADR 0011 §23 point 2 : aucun scan lancé par Rust (l'API Rust du plugin n'existe pas) : refusé sur toutes les plateformes.
      return fail('invalid-pairing');
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
    const { readable, kids, epochs } = folderKids(f, pairedBy);
    if (readable === 0) return fail('cloud-pending');
    if (!kids.has(kid)) return fail('key-mismatch');
    // Y-11 : la clé locale déjà retirée (réinitialisation en cours ici, ou annonce d'un autre appareil qui l'emporte) n'« associe » rien.
    if (key && key.kid === kid && bound !== null && (activeNext() !== null || oldKeyWithdrawn(f, kid, bound))) return fail('key-mismatch');
    // Y-11 : appareil déjà associé avec une autre clé qui importe la nouvelle clé d'une réinitialisation : sous `.next`, jamais par-dessus
    // `.v1` avant la bascule (confirmation native de remplacement de Y-08), registre `joined`.
    if (key && key.kid !== kid) {
      const plan = joinPlan(f, key.kid, kid, epochs.get(kid));
      if (plan === 'already') {
        pairing = null;
        return { kid, pairedBy, epoch: epochs.get(kid) ?? null };
      }
      if (plan) {
        askConsent();
        nextKey = { raw, kid };
        resetRecord = plan;
        sealedNext = 0;
        if (own && pairedBy !== null) own.pairedBy = pairedBy;
        pairing = null;
        return { kid, pairedBy, epoch: plan.epoch };
      }
    }
    if (key && key.kid !== kid) askConsent();
    if (!key || key.kid !== kid) {
      key = { raw, kid };
      sealed = 0; // budget de nonces compté par clé
    }
    if (!own || own.folderId !== f.id || own.kid !== kid) own = bound ? rebuildOwn(f, kid, bound) : null;
    if (own && pairedBy !== null) own.pairedBy = pairedBy;
    pendingPairedBy = pairedBy;
    // Y-10 : appareil déjà lié : registre créé avec la clé (sinon au premier scan, mêmes règles).
    if (bound !== null) {
      try {
        ensureRegistry(f, kid, bound);
      } catch {
        // reporté au premier scan, qui applique les mêmes règles et le signale
      }
    }
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
          registry = null;
          accepted.clear(); // l'anti-rejeu vaut pour un dossier : les états d'un autre dossier ne comparent rien
          // Y-11 : une réinitialisation est liée à son dossier ; un autre dossier l'abandonne (`.v1` reste valide ; `.next` effacée même
          // sans registre, revue 10).
          nextKey = null;
          resetRecord = null;
          sealedNext = 0;
        }
        folder = next;
        // Y-10 : appareil lié et clé présente : registre du dossier créé dès le choix (sinon au premier scan, mêmes règles).
        if (bound !== null && key && vaultAvailable) {
          try {
            ensureRegistry(next, key.kid, bound);
          } catch {
            // reporté au premier scan, qui applique les mêmes règles et le signale
          }
        }
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
        registry = null;
        bound = null;
        pairing = null;
        pendingPairedBy = null;
        accepted.clear();
        // Y-11 : réinitialisation liée au dossier : abandonnée (nouvelle clé effacée sans condition, audit 7 et revue 10 ; `.v1` gardée
        // sauf `eraseKey`) ; échec d'import effacé (§18 point 17).
        nextKey = null;
        resetRecord = null;
        sealedNext = 0;
        importFailure = null;
        if (eraseKey) {
          key = null;
          sealed = 0;
        }
      },
    },
    key: {
      status: async () => {
        requireVault();
        const failure = importFailure && folder && importFailure.folderId === folder.id ? { code: importFailure.code, at: importFailure.at as IsoDateTime } : null;
        return { present: key !== null, kid: key?.kid ?? null, nextKid: nextKey?.kid ?? null, importFailure: failure };
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
        // Y-10 : appareil déjà lié, dossier sans données : registre créé dès maintenant (rien n'a été publié).
        if (bound !== null) ensureRegistry(f, key.kid, bound);
        return { kid: key.kid };
      },
      openPairing: async (mode) => {
        if (devicePlatform !== 'windows') return fail('wrong-window');
        if (mode !== 'show' && mode !== 'import') return fail('wrong-mode');
        const f = requireFolder();
        if (mode === 'show') {
          const k = requireKey();
          const self = requireBound();
          // Y-11 (D1) : jamais l'ancienne clé quand une réinitialisation d'un autre appareil est annoncée (ou que la sienne a perdu).
          if (!activeNext() && oldKeyWithdrawn(f, k.kid, self)) return fail('state-mismatch');
        }
        // Libellé `pairing` déjà pris (avant ou pendant la boîte) : refus, rien n'est créé.
        if (livePairing()) return fail('already-open');
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
      // ADR 0011 §23 point 2 : scan du QR par le JS, iPhone seulement (absent du PC) ; le texte lu (fourni par le test ou le simulateur,
      // jamais par la page) est passé aussitôt à l'import et n'est jamais rendu.
      ...(devicePlatform === 'ios'
        ? {
            scanAndImport: async (): Promise<ScanImportOutcome> => {
              if (!foreground) return { kind: 'failed', code: 'not-foreground' };
              if (camera === 'prompt') camera = cameraAnswer;
              if (camera === 'denied') return { kind: 'camera-denied' };
              const text = scanResult;
              scanResult = null;
              if (text === null) return { kind: 'cancelled' };
              try {
                return { kind: 'imported', result: await importKey({ qrText: text }) };
              } catch (error) {
                return { kind: 'failed', code: error instanceof SyncPlatformError ? error.code : 'io' };
              }
            },
            cancelScan: async () => {
              scanResult = null;
            },
            cameraPermission: async (): Promise<CameraPermission> => camera,
            openCameraSettings: async () => {
              settingsOpened += 1;
            },
          }
        : {}),
    },
    bindDevice: async (deviceId) => {
      if (!isSyncDeviceId(deviceId)) return fail('bad-name');
      requireFolder();
      if (bound !== null && bound !== deviceId) return fail('already-bound');
      bound = deviceId;
      // Y-10 : registre créé dès la liaison s'il manque (même règle que Rust ; sinon au premier scan).
      if (key && vaultAvailable) {
        try {
          ensureRegistry(requireFolder(), key.kid, deviceId);
        } catch {
          // reporté au premier scan, qui applique les mêmes règles et le signale
        }
      }
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
    // Y-10 : mêmes contrôles que `sync_device_forget` et `sync_forgotten_delete` de Rust (`forget.rs`, `SyncCore`).
    forget: {
      device: deviceForget,
      deleteFiles: forgottenDelete,
    },
    // Y-11 : mêmes contrôles que `sync_reset_key` de Rust (`reset.rs`, `SyncCore::reset_key`).
    reset: {
      start: resetStart,
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
      setCameraPermission: (state, answer) => {
        camera = state;
        if (answer) cameraAnswer = answer;
      },
      cameraSettingsOpened: () => settingsOpened,
      setHydrationDelay: (ms) => {
        hydrationDelay = ms;
      },
      hydrationBudgetLeft: () => hydrationLeft,
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
      clearClosedSegments: () => {
        if (own) own.closed = [];
      },
      setResetInProgress: (value) => {
        resetPending = value;
      },
      forgottenDeclarations: () => registry?.entries ?? [],
      forgottenRegistry: () => (registry ? { entries: [...registry.entries], done: [...registry.done] } : null),
      dropForgottenFile: () => {
        registry = null;
      },
      setForgottenFileCorrupt: (value) => {
        registryCorrupt = value;
      },
      interruptBefore: (step) => {
        interruptAt = step;
      },
      resetRecord: () =>
        resetRecord
          ? {
              role: resetRecord.role,
              kid: resetRecord.kid,
              epoch: resetRecord.epoch,
              by: resetRecord.by,
              stage: resetRecord.stage,
              base: resetRecord.base ? { ...resetRecord.base } : null,
              superseded: resetRecord.superseded ? { ...resetRecord.superseded } : null,
              switchStep: resetRecord.switchStep,
              noticeSeq: resetRecord.noticeSeq,
            }
          : null,
      nextKid: () => nextKey?.kid ?? null,
      sealedNextRecords: () => sealedNext,
    },
  };
  return platform;
}
