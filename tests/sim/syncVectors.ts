/**
 * Construction déterministe de `tests/fixtures/sync/vectors.json` (ADR 0011, sections 1.2, 1.3, 2 et 12 ; Y-08 critère 4).
 *
 * Les vecteurs sont produits par le codec de référence (`syncCodec.ts`) avec des nonces imposés, puis vérifiés par Vitest
 * (`tests/unit/syncCodec.test.ts`) et par `cargo test` (`src-tauri/tests/desktop/sync_crypto.rs`). La section `rustSealed` est écrite
 * une fois par Rust (nonce tiré par la bibliothèque) et lue par le codec : elle n'est pas reconstruite ici.
 *
 * Régénération : `CT_WRITE_SYNC_VECTORS=1 npx vitest run tests/unit/syncCodec.test.ts` (garde `rustSealed`).
 */

import { encryptedLineBytes, paddedPlaintextBytes, type FileHeader } from '../../src/domain/sync/format';
import { aadBytes, aadFields, headerLine, kidOf, qrTextOf, recordKeyOf, recoveryKeyOf, sealRecord, toHex, type Bytes, type RecordPlace } from './syncCodec';
import type { DeviceId } from '../../src/domain/types';
import type { EpochId } from '../../src/domain/sync/format';

/** Texte clair : littéral, ou chaîne JSON `"aaa…"` d'exactement `bytes` octets (grands enregistrements). */
export type VectorPlaintext = { readonly json: string } | { readonly jsonStringBytes: number };

export interface RecordVector {
  readonly name: string;
  readonly place: RecordPlace;
  readonly sm: number;
  readonly sv: number;
  readonly plaintext: VectorPlaintext;
  readonly nonce: string;
  /** Ligne complète (petits enregistrements) ou son condensé SHA-256 (grands). */
  readonly line?: string;
  readonly lineSha256?: string;
  /** Octets écrits sur disque, `\n` compris = `encryptedLineBytes`. */
  readonly lineBytes: number;
}

export interface LineGroup {
  readonly sv: number;
  /** Paliers de 4 Kio du texte clair bourré ; le texte clair vaut `4096 × blocks − 4` octets. */
  readonly blocks: number;
  readonly count: number;
}

export interface SyncVectors {
  readonly description: string;
  readonly key: string;
  readonly recordKey: string;
  readonly kid: string;
  readonly recoveryKey: string;
  readonly recoveryInputs: readonly { readonly input: string; readonly ok: boolean }[];
  readonly qr: { readonly deviceId: string; readonly epoch: string | null; readonly expiresAt: number; readonly text: string };
  readonly aad: readonly { readonly place: RecordPlace; readonly sm: number; readonly sv: number; readonly hex: string }[];
  readonly padding: readonly { readonly jsonBytes: number; readonly paddedBytes: number }[];
  readonly headers: readonly { readonly header: FileHeader; readonly line: string; readonly bytes: number }[];
  readonly records: readonly RecordVector[];
  readonly limits: {
    readonly segment: {
      readonly header: FileHeader;
      readonly headerBytes: number;
      readonly prefix: readonly LineGroup[];
      readonly last: { readonly blocks: number; readonly acceptedSv: number; readonly refusedSv: number };
      readonly total: number;
    };
    readonly appendCall: { readonly accepted: readonly LineGroup[]; readonly refused: readonly LineGroup[]; readonly limit: number };
  };
  readonly rustSealed: readonly { readonly place: RecordPlace; readonly sm: number; readonly sv: number; readonly json: string; readonly line: string }[];
}

export const VECTOR_DEVICE = '3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60' as DeviceId;
export const VECTOR_OTHER_DEVICE = '7d4e1a2b-3c5f-4a6b-8d7e-9f0a1b2c3d4e' as DeviceId;
export const VECTOR_EPOCH = `e0001-${VECTOR_DEVICE}` as EpochId;

/** Clé fixe des vecteurs (jamais une vraie clé). */
export function vectorKey(): Bytes {
  const key = new Uint8Array(32);
  for (let i = 0; i < key.length; i += 1) key[i] = (i * 37 + 11) & 0xff;
  return key;
}

function nonceOf(seed: number): Bytes {
  const nonce = new Uint8Array(12);
  for (let i = 0; i < nonce.length; i += 1) nonce[i] = (seed * 29 + i * 13 + 5) & 0xff;
  return nonce;
}

export function plaintextOf(p: VectorPlaintext): string {
  return 'json' in p ? p.json : `"${'a'.repeat(p.jsonStringBytes - 2)}"`;
}

export const blockPlaintext = (blocks: number): VectorPlaintext => ({ jsonStringBytes: 4096 * blocks - 4 });

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

const journal = (segment: number, index: number): RecordPlace => ({ kind: 'j', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, segment, index });

export async function buildSyncVectors(rustSealed: SyncVectors['rustSealed'] = []): Promise<SyncVectors> {
  const key = vectorKey();
  const kid = await kidOf(key);
  const recoveryKey = await recoveryKeyOf(key);
  const compact = recoveryKey.replace(/-/g, '');
  const tolerant = recoveryKey.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  const lastChar = compact.at(-1) ?? '0';
  const otherLast = lastChar === '0' ? '4' : '0';
  const recoveryInputs = [
    { input: recoveryKey, ok: true },
    { input: compact, ok: true },
    { input: tolerant, ok: true },
    { input: `  ${recoveryKey.slice(4)}  `, ok: true },
    // Dernier caractère changé : somme de contrôle (ou bits de remplissage) fausse.
    { input: compact.slice(0, -1) + otherLast, ok: false },
    { input: compact.slice(0, -5), ok: false },
    { input: compact.replace(/.$/, 'U'), ok: false },
  ];

  const places: { readonly place: RecordPlace; readonly sm: number; readonly sv: number }[] = [
    { place: journal(1, 0), sm: 1, sv: 14 },
    { place: { kind: 's', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, seq: 3, index: 7 }, sm: 1, sv: 14 },
    { place: { kind: 'state', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, stateSeq: 42 }, sm: 1, sv: 14 },
  ];
  const aad = places.map((p) => ({ ...p, hex: toHex(aadBytes(aadFields(p.place, p.sm, p.sv))) }));

  const padding = [0, 1, 2, 4092, 4093, 5000, 8188, 8189, 262_144].map((jsonBytes) => ({ jsonBytes, paddedBytes: paddedPlaintextBytes(jsonBytes) }));

  const header = (f: FileHeader['f'], n: number): FileHeader => ({ f, sm: 1, kid, dev: VECTOR_DEVICE, e: VECTOR_EPOCH, n });
  const headers = [header('ct-j', 1), header('ct-s', 12), header('ct-state', 99_999_999), header('ct-state', 123_456_789_012)].map((h) => {
    const line = headerLine(h);
    return { header: h, line, bytes: new TextEncoder().encode(line).length + 1 };
  });

  const specs: { readonly name: string; readonly place: RecordPlace; readonly sm: number; readonly sv: number; readonly plaintext: VectorPlaintext; readonly full: boolean }[] = [
    {
      name: 'journal-ops',
      place: journal(1, 0),
      sm: 1,
      sv: 14,
      plaintext: { json: '{"k":"ops","sv":14,"ops":[{"t":"task","id":"t1","at":"2026-10-05T08:00:00.000Z","f":{"title":["Acheter du pain","000001759651200000-0000-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60",null]}}]}' },
      full: true,
    },
    { name: 'smallest', place: journal(1, 1), sm: 1, sv: 1, plaintext: { json: '{}' }, full: true },
    { name: 'empty', place: journal(2, 0), sm: 1, sv: 1, plaintext: { json: '' }, full: true },
    { name: 'four-kib-boundary', place: journal(2, 1), sm: 1, sv: 14, plaintext: { jsonStringBytes: 4092 }, full: true },
    { name: 'four-kib-plus-one', place: journal(2, 2), sm: 1, sv: 14, plaintext: { jsonStringBytes: 4093 }, full: true },
    { name: 'digits', place: journal(12, 345), sm: 12, sv: 123_456, plaintext: { json: '{"k":"ops","sv":123456,"ops":[]}' }, full: true },
    { name: 'utf8', place: journal(3, 0), sm: 1, sv: 14, plaintext: { json: '{"title":"Réunion à 9 h — café ☕"}' }, full: true },
    {
      name: 'snapshot',
      place: { kind: 's', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, seq: 3, index: 7 },
      sm: 1,
      sv: 14,
      plaintext: { json: '{"k":"snap-rows","rows":[]}' },
      full: true,
    },
    {
      name: 'state',
      place: { kind: 'state', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, stateSeq: 42 },
      sm: 1,
      sv: 14,
      plaintext: { json: '{"deviceId":"3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60"}' },
      full: true,
    },
    { name: 'max-256-kib', place: journal(4, 0), sm: 1, sv: 999_999, plaintext: { jsonStringBytes: 256 * 1024 }, full: false },
  ];
  const records: RecordVector[] = [];
  for (const [i, spec] of specs.entries()) {
    const nonce = nonceOf(i + 1);
    const json = plaintextOf(spec.plaintext);
    const line = await sealRecord({ key, place: spec.place, json, sm: spec.sm, sv: spec.sv, nonce });
    const lineBytes = new TextEncoder().encode(line).length + 1;
    if (lineBytes !== encryptedLineBytes(new TextEncoder().encode(json).length, spec.sm, spec.sv)) throw new Error(`encryptedLineBytes faux : ${spec.name}`);
    records.push({
      name: spec.name,
      place: spec.place,
      sm: spec.sm,
      sv: spec.sv,
      plaintext: spec.plaintext,
      nonce: toHex(nonce),
      ...(spec.full ? { line } : { lineSha256: await sha256Hex(line) }),
      lineBytes,
    });
  }

  // Plafonds (section 1.3, avenant « Amorce ») : combinaisons de lignes dont la somme tombe exactement sur 1 Mio et 1 Mio + 1.
  const segmentHeader = header('ct-j', 1);
  const segmentHeaderBytes = new TextEncoder().encode(headerLine(segmentHeader)).length + 1;
  const MIB = 1024 * 1024;

  return {
    description:
      'Vecteurs croisés de la synchro (ADR 0011, sections 1.2, 1.3, 2 ; Y-08). Produits par tests/sim/syncVectors.ts, vérifiés par Vitest et cargo test. Clé de test, jamais une vraie clé.',
    key: toHex(key),
    recordKey: toHex(await recordKeyOf(key)),
    kid,
    recoveryKey,
    recoveryInputs,
    qr: { deviceId: VECTOR_DEVICE, epoch: VECTOR_EPOCH, expiresAt: 1_790_000_000_000, text: qrTextOf({ key, deviceId: VECTOR_DEVICE, epoch: VECTOR_EPOCH, expiresAt: 1_790_000_000_000 }) },
    aad,
    padding,
    headers,
    records,
    limits: {
      segment: {
        header: segmentHeader,
        headerBytes: segmentHeaderBytes,
        prefix: [
          { sv: 1, blocks: 1, count: 73 },
          { sv: 1, blocks: 2, count: 50 },
          { sv: 1, blocks: 17, count: 1 },
        ],
        last: { blocks: 1, acceptedSv: 9, refusedSv: 10 },
        total: MIB,
      },
      appendCall: {
        accepted: [
          { sv: 1, blocks: 1, count: 127 },
          { sv: 1, blocks: 64, count: 1 },
        ],
        refused: [
          { sv: 1, blocks: 1, count: 125 },
          { sv: 1, blocks: 3, count: 2 },
          { sv: 1, blocks: 60, count: 1 },
        ],
        limit: MIB,
      },
    },
    rustSealed,
  };
}

/** Octets sur disque d'un groupe de lignes. */
export const groupBytes = (groups: readonly LineGroup[]): number =>
  groups.reduce((total, g) => total + g.count * encryptedLineBytes(4096 * g.blocks - 4, 1, g.sv), 0);
