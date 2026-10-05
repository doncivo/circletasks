/**
 * Codec de référence de la synchronisation (ADR 0011, sections 1.2 et 2 ; Y-08), en Web Crypto de Node.
 *
 * Il produit et lit exactement ce qu'écrit `src-tauri/src/sync/crypto.rs` : en-tête en clair, lignes `<sm>.<sv>.<base64url(nonce ‖
 * texte chiffré ‖ étiquette)>`, texte clair bourré (`u32 gros-boutiste ‖ JSON ‖ zéros` au multiple de 4 Kio), AAD dont chaque champ
 * est préfixé par sa longueur (u16 gros-boutiste), clé d'enregistrement et `kid` dérivés par HKDF-SHA256, clé de secours et texte
 * du QR. Les deux implémentations sont vérifiées sur `tests/fixtures/sync/vectors.json` (Vitest ici, `cargo test` côté Rust).
 *
 * **Jamais embarqué** dans l'app : sert aux tests et à la simulation à deux dossiers (lot Y2). En production, seul Rust chiffre.
 */

import {
  AAD_VERSION,
  MAX_RECORD_LINE_BYTES,
  NONCE_BYTES,
  PADDING_LENGTH_PREFIX_BYTES,
  PAIRING_QR_PREFIX,
  RECOVERY_KEY_PREFIX,
  TAG_BYTES,
  hasStrictJsonShape,
  isEpochId,
  isSyncDeviceId,
  paddedPlaintextBytes,
  parseRecordLinePrefix,
  type EpochId,
  type FileHeader,
} from '../../src/domain/sync/format';
import type { DeviceId } from '../../src/domain/types';

export type Bytes = Uint8Array<ArrayBuffer>;

/** Clé maîtresse `K` : 32 octets. */
export const KEY_BYTES = 32;
/** Sel et `info` de HKDF-SHA256 (section 2). */
export const HKDF_SALT = 'circletasks';
export const HKDF_INFO_RECORDS = 'ct/1 records';
export const HKDF_INFO_KID = 'ct/1 kid';

const encoder = new TextEncoder();
const subtle = globalThis.crypto.subtle;

// ---------------------------------------------------------------------------------------------------------------------------------
// Encodages
// ---------------------------------------------------------------------------------------------------------------------------------

export const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function fromHex(text: string): Bytes {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new TypeError('hexadécimal invalide');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url sans remplissage, strict (alphabet, longueur) ; null sinon. */
export function fromBase64Url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  // Écriture canonique seulement (bits de remplissage nuls) : un même contenu n'a qu'une forme.
  return toBase64Url(bytes) === text ? bytes : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Dérivations (section 2)
// ---------------------------------------------------------------------------------------------------------------------------------

async function hkdf(key: Bytes, info: string, bytes: number): Promise<Bytes> {
  if (key.length !== KEY_BYTES) throw new RangeError('clé de 32 octets attendue');
  const base = await subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(HKDF_SALT), info: encoder.encode(info) }, base, bytes * 8);
  return new Uint8Array(bits);
}

/** `K_rec = HKDF(K, info "ct/1 records")`, 32 octets : chiffre tous les fichiers. */
export const recordKeyOf = (key: Bytes): Promise<Bytes> => hkdf(key, HKDF_INFO_RECORDS, 32);

/** `kid = hex(HKDF(K, info "ct/1 kid")[0..8])` : 16 caractères hexadécimaux. */
export const kidOf = async (key: Bytes): Promise<string> => toHex(await hkdf(key, HKDF_INFO_KID, 8));

// ---------------------------------------------------------------------------------------------------------------------------------
// AAD (section 2)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Place d'un enregistrement : reconstruite par le lecteur depuis le chemin, l'en-tête (qui doit lui correspondre) et la position. */
export type RecordPlace =
  | { readonly kind: 'j'; readonly dev: string; readonly epoch: string; readonly segment: number; readonly index: number }
  | { readonly kind: 's'; readonly dev: string; readonly epoch: string; readonly seq: number; readonly index: number }
  | { readonly kind: 'state'; readonly dev: string; readonly epoch: string; readonly stateSeq: number };

/** Champs de l'AAD, dans l'ordre : journal `ct/1|j|dev|époque|segment|index|sm|sv`, instantané `ct/1|s|…`, état `ct/1|state|dev|époque|stateSeq|sm|sv`. */
export function aadFields(place: RecordPlace, sm: number, sv: number): string[] {
  switch (place.kind) {
    case 'j':
      return [AAD_VERSION, 'j', place.dev, place.epoch, String(place.segment), String(place.index), String(sm), String(sv)];
    case 's':
      return [AAD_VERSION, 's', place.dev, place.epoch, String(place.seq), String(place.index), String(sm), String(sv)];
    case 'state':
      return [AAD_VERSION, 'state', place.dev, place.epoch, String(place.stateSeq), String(sm), String(sv)];
  }
}

/** Chaque champ préfixé par sa longueur en octets (u16 gros-boutiste), puis ses octets UTF-8 : aucune ambiguïté de séparateur. */
export function aadBytes(fields: readonly string[]): Bytes {
  const parts = fields.map((field) => encoder.encode(field));
  const out = new Uint8Array(parts.reduce((total, part) => total + 2 + part.length, 0));
  let at = 0;
  for (const part of parts) {
    if (part.length > 0xffff) throw new RangeError('champ d’AAD trop long');
    out[at] = part.length >> 8;
    out[at + 1] = part.length & 0xff;
    out.set(part, at + 2);
    at += 2 + part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Bourrage (section 1.2, audit M1)
// ---------------------------------------------------------------------------------------------------------------------------------

/** `longueur JSON (u32 gros-boutiste) ‖ JSON ‖ zéros` jusqu'au multiple de 4 Kio supérieur (4 Kio au minimum). */
export function padPlaintext(json: Uint8Array): Bytes {
  const out = new Uint8Array(paddedPlaintextBytes(json.length));
  new DataView(out.buffer).setUint32(0, json.length, false);
  out.set(json, PADDING_LENGTH_PREFIX_BYTES);
  return out;
}

/** Contrôle de la longueur annoncée, de la taille bourrée et de la nullité du bourrage ; null : corruption. */
export function unpadPlaintext(padded: Uint8Array): Uint8Array | null {
  if (padded.length < PADDING_LENGTH_PREFIX_BYTES) return null;
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (length > padded.length - PADDING_LENGTH_PREFIX_BYTES || paddedPlaintextBytes(length) !== padded.length) return null;
  const end = PADDING_LENGTH_PREFIX_BYTES + length;
  for (let i = end; i < padded.length; i += 1) if (padded[i] !== 0) return null;
  return padded.subarray(PADDING_LENGTH_PREFIX_BYTES, end);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Lignes chiffrées (section 1.2)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SealInput {
  /** Clé maîtresse `K` (la clé d'enregistrement en est dérivée). */
  readonly key: Bytes;
  readonly place: RecordPlace;
  /** Texte clair JSON. */
  readonly json: string;
  readonly sm: number;
  readonly sv: number;
  /** Nonce imposé (vecteurs seulement ; Rust le tire toujours au hasard). */
  readonly nonce?: Bytes;
}

/** Ligne `<sm>.<sv>.<base64url(nonce ‖ texte chiffré ‖ étiquette)>`, sans `\n`. */
export async function sealRecord(input: SealInput): Promise<string> {
  const nonce = input.nonce ?? globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  if (nonce.length !== NONCE_BYTES) throw new RangeError('nonce de 12 octets attendu');
  const aes = await subtle.importKey('raw', await recordKeyOf(input.key), 'AES-GCM', false, ['encrypt']);
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aadBytes(aadFields(input.place, input.sm, input.sv)), tagLength: TAG_BYTES * 8 },
      aes,
      padPlaintext(encoder.encode(input.json)),
    ),
  );
  const payload = new Uint8Array(NONCE_BYTES + sealed.length);
  payload.set(nonce, 0);
  payload.set(sealed, NONCE_BYTES);
  return `${String(input.sm)}.${String(input.sv)}.${toBase64Url(payload)}`;
}

export interface OpenedRecord {
  readonly sm: number;
  readonly sv: number;
  readonly json: string;
}

/** Ouvre une ligne (sans `\n`) à sa place ; null si la ligne est malformée ou ne se déchiffre pas (AAD, clé, étiquette, bourrage). */
export async function openRecord(key: Bytes, place: RecordPlace, line: string): Promise<OpenedRecord | null> {
  if (line.length > MAX_RECORD_LINE_BYTES) return null;
  const prefix = parseRecordLinePrefix(line);
  if (!prefix) return null;
  const payload = fromBase64Url(prefix.payload);
  if (!payload || payload.length < NONCE_BYTES + TAG_BYTES) return null;
  const aes = await subtle.importKey('raw', await recordKeyOf(key), 'AES-GCM', false, ['decrypt']);
  let padded: Bytes;
  try {
    padded = new Uint8Array(
      await subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: payload.subarray(0, NONCE_BYTES),
          additionalData: aadBytes(aadFields(place, prefix.sm, prefix.sv)),
          tagLength: TAG_BYTES * 8,
        },
        aes,
        payload.subarray(NONCE_BYTES),
      ),
    );
  } catch {
    return null;
  }
  const json = unpadPlaintext(padded);
  if (!json) return null;
  try {
    return { sm: prefix.sm, sv: prefix.sv, json: new TextDecoder('utf-8', { fatal: true }).decode(json) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// En-tête et fichier
// ---------------------------------------------------------------------------------------------------------------------------------

/** En-tête en clair, clés dans l'ordre écrit par Rust : `f`, `sm`, `kid`, `dev`, `e`, `n` (sans `\n`). */
export function headerLine(header: FileHeader): string {
  return JSON.stringify({ f: header.f, sm: header.sm, kid: header.kid, dev: header.dev, e: header.e, n: header.n });
}

/** Contenu d'un fichier : en-tête puis une ligne par enregistrement, chacune terminée par `\n`. */
export function fileText(header: FileHeader, lines: readonly string[]): string {
  return [headerLine(header), ...lines].map((line) => `${line}\n`).join('');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Clé de secours (section 2)
// ---------------------------------------------------------------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RECOVERY_BYTES = KEY_BYTES + 2;
/** 34 octets en base32 : 55 caractères utiles. */
export const RECOVERY_CHARS = Math.ceil((RECOVERY_BYTES * 8) / 5);

async function sha256(bytes: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/** `K ‖ SHA-256(K)[0..2]` en base32 Crockford, groupes de 5 caractères, préfixe `CT1-`. */
export async function recoveryKeyOf(key: Bytes): Promise<string> {
  if (key.length !== KEY_BYTES) throw new RangeError('clé de 32 octets attendue');
  const data = new Uint8Array(RECOVERY_BYTES);
  data.set(key, 0);
  data.set((await sha256(key)).subarray(0, 2), KEY_BYTES);
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

/**
 * Saisie tolérante (casse ASCII, espaces et retours ASCII, tirets, `O`/`0`, `I`/`L`/`1`), somme de contrôle vérifiée ; null si invalide.
 * Mêmes règles que Rust (QA-Y1-4) : 256 octets au plus, majuscules ASCII seulement (ni « ı » ni « ſ »), ni espace insécable.
 */
export async function keyFromRecovery(input: string): Promise<Bytes | null> {
  if (encoder.encode(input).length > 256) return null;
  let text = input
    .replace(/[a-z]/g, (c) => c.toUpperCase())
    .replace(/[ \t\n\r-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
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
  if (value !== 0) return null;
  const key = data.slice(0, KEY_BYTES);
  const digest = await sha256(key);
  return digest[0] === data[KEY_BYTES] && digest[1] === data[KEY_BYTES + 1] ? key : null;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Texte du QR (section 10.3)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface QrContent {
  readonly key: Bytes;
  /** Appareil qui affiche le QR (PC). */
  readonly deviceId: DeviceId;
  readonly epoch: EpochId | null;
  /** Expiration, ms Unix. */
  readonly expiresAt: number;
}

/** `CTPAIR1.<base64url(JSON { v:1, k, d, e, x })>`, clés dans cet ordre. */
export function qrTextOf(content: QrContent): string {
  const json = JSON.stringify({ v: 1, k: toBase64Url(content.key), d: content.deviceId, e: content.epoch, x: content.expiresAt });
  return PAIRING_QR_PREFIX + toBase64Url(encoder.encode(json));
}

/** Analyse stricte du texte du QR ; null si invalide. */
export function parseQrText(text: string): QrContent | null {
  if (!text.startsWith(PAIRING_QR_PREFIX) || text.length > 1024) return null;
  const bytes = fromBase64Url(text.slice(PAIRING_QR_PREFIX.length));
  if (!bytes) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'd,e,k,v,x') return null;
  // Comme serde (QA-Y1-4) : clé répétée refusée, `v` et `x` entiers canoniques (ni `1.0`, ni `1e0`).
  if (!hasStrictJsonShape(new TextDecoder().decode(bytes), 5)) return null;
  const q = value as Record<string, unknown>;
  if (q['v'] !== 1 || typeof q['k'] !== 'string' || !isSyncDeviceId(q['d'])) return null;
  if (q['e'] !== null && !isEpochId(q['e'])) return null;
  if (typeof q['x'] !== 'number' || !Number.isSafeInteger(q['x']) || q['x'] < 0) return null;
  const key = fromBase64Url(q['k']);
  if (!key || key.length !== KEY_BYTES) return null;
  return { key, deviceId: q['d'], epoch: q['e'], expiresAt: q['x'] };
}
