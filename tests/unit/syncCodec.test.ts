// Y-08 : codec de référence de la synchro et vecteurs croisés (ADR 0011, sections 1.2, 1.3, 2 et 12).
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_APPEND_CALL_BYTES,
  SEGMENT_ROTATE_BYTES,
  encryptedLineBytes,
  paddedPlaintextBytes,
  parseFileHeader,
} from '../../src/domain/sync/format';
import {
  aadBytes,
  aadFields,
  fileText,
  fromHex,
  headerLine,
  keyFromRecovery,
  kidOf,
  openRecord,
  padPlaintext,
  parseQrText,
  qrTextOf,
  recordKeyOf,
  recoveryKeyOf,
  sealRecord,
  toHex,
  unpadPlaintext,
  type RecordPlace,
} from '../sim/syncCodec';
import { VECTOR_DEVICE, VECTOR_EPOCH, VECTOR_OTHER_DEVICE, buildSyncVectors, groupBytes, plaintextOf, vectorKey, type SyncVectors } from '../sim/syncVectors';

const VECTORS_URL = new URL('../fixtures/sync/vectors.json', import.meta.url);
const vectors = JSON.parse(readFileSync(VECTORS_URL, 'utf8')) as SyncVectors;
const key = fromHex(vectors.key);
const utf8 = (text: string): number => new TextEncoder().encode(text).length;

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

describe('vecteurs croisés (Y-08 critère 4)', () => {
  it('le fichier est exactement celui que produit le générateur (rustSealed mis à part)', async () => {
    const built = await buildSyncVectors(vectors.rustSealed);
    if (process.env['CT_WRITE_SYNC_VECTORS'] === '1') writeFileSync(VECTORS_URL, `${JSON.stringify(built, null, 2)}\n`);
    expect(vectors).toEqual(built);
  });

  it('clé d’enregistrement, kid et clé de secours dérivés de K (HKDF-SHA256, sel « circletasks »)', async () => {
    expect(toHex(await recordKeyOf(key))).toBe(vectors.recordKey);
    expect(await kidOf(key)).toBe(vectors.kid);
    expect(vectors.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(vectors.recordKey).not.toContain(vectors.kid);
    expect(await recoveryKeyOf(key)).toBe(vectors.recoveryKey);
  });

  it('clé de secours : 55 caractères utiles en groupes de 5 préfixés CT1-, saisie tolérante, somme de contrôle', async () => {
    expect(vectors.recoveryKey).toMatch(/^CT1-([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    for (const { input, ok } of vectors.recoveryInputs) {
      const decoded = await keyFromRecovery(input);
      expect(decoded === null ? null : toHex(decoded), input).toBe(ok ? vectors.key : null);
    }
  });

  it('AAD : chaque champ préfixé par sa longueur (u16 gros-boutiste)', () => {
    for (const v of vectors.aad) expect(toHex(aadBytes(aadFields(v.place, v.sm, v.sv)))).toBe(v.hex);
    // ct/1 | j : 00 04 'ct/1' 00 01 'j' …
    expect(vectors.aad[0]?.hex.startsWith('0004' + toHex(new TextEncoder().encode('ct/1')) + '00016a')).toBe(true);
  });

  it('bourrage au multiple de 4 Kio supérieur (4 Kio au minimum), longueur annoncée et zéros contrôlés', () => {
    for (const p of vectors.padding) {
      expect(paddedPlaintextBytes(p.jsonBytes)).toBe(p.paddedBytes);
      const json = new Uint8Array(p.jsonBytes).fill(0x61);
      const padded = padPlaintext(json);
      expect(padded.length).toBe(p.paddedBytes);
      expect(unpadPlaintext(padded)).toEqual(json);
    }
    const padded = padPlaintext(new TextEncoder().encode('{}'));
    const dirty = padded.slice();
    dirty[100] = 1;
    expect(unpadPlaintext(dirty)).toBeNull();
    const lying = padded.slice();
    lying[2] = 0x0f; // 4 093 octets annoncés : ne tient pas dans un seul palier de 4 Kio
    lying[3] = 0xfd;
    expect(unpadPlaintext(lying)).toBeNull();
    expect(unpadPlaintext(padded.subarray(0, 4000))).toBeNull();
  });

  it('en-têtes : clés dans l’ordre f, sm, kid, dev, e, n, analysés strictement par format.ts', () => {
    for (const h of vectors.headers) {
      expect(headerLine(h.header)).toBe(h.line);
      expect(utf8(h.line) + 1).toBe(h.bytes);
      if (h.header.n <= Number.MAX_SAFE_INTEGER) expect(parseFileHeader(h.line)).toEqual(h.header);
    }
    expect(vectors.limits.segment.headerBytes).toBe(utf8(headerLine(vectors.limits.segment.header)) + 1);
  });

  it('chaque ligne se déchiffre à sa place et sa longueur égale encryptedLineBytes', async () => {
    for (const r of vectors.records) {
      const json = plaintextOf(r.plaintext);
      const line = await sealRecord({ key, place: r.place, json, sm: r.sm, sv: r.sv, nonce: fromHex(r.nonce) });
      if (r.line !== undefined) expect(line).toBe(r.line);
      else expect(await sha256Hex(line)).toBe(r.lineSha256);
      expect(utf8(line) + 1).toBe(r.lineBytes);
      expect(encryptedLineBytes(utf8(json), r.sm, r.sv)).toBe(r.lineBytes);
      expect(await openRecord(key, r.place, line)).toEqual({ sm: r.sm, sv: r.sv, json });
    }
  });

  it('les lignes écrites par Rust se déchiffrent avec le codec de référence', async () => {
    for (const r of vectors.rustSealed) {
      expect(await openRecord(key, r.place, r.line)).toEqual({ sm: r.sm, sv: r.sv, json: r.json });
      expect(utf8(r.line) + 1).toBe(encryptedLineBytes(utf8(r.json), r.sm, r.sv));
    }
  });

  it('plafonds : segment de 1 Mio exact accepté, 1 Mio + 1 refusé ; appel de 1 Mio exact, 1 Mio + 1 refusé', () => {
    const s = vectors.limits.segment;
    const prefix = s.headerBytes + groupBytes(s.prefix);
    expect(prefix + groupBytes([{ sv: s.last.acceptedSv, blocks: s.last.blocks, count: 1 }])).toBe(SEGMENT_ROTATE_BYTES);
    expect(prefix + groupBytes([{ sv: s.last.refusedSv, blocks: s.last.blocks, count: 1 }])).toBe(SEGMENT_ROTATE_BYTES + 1);
    expect(groupBytes(s.prefix)).toBeLessThanOrEqual(MAX_APPEND_CALL_BYTES);
    expect(groupBytes(vectors.limits.appendCall.accepted)).toBe(MAX_APPEND_CALL_BYTES);
    expect(groupBytes(vectors.limits.appendCall.refused)).toBe(MAX_APPEND_CALL_BYTES + 1);
  });
});

describe('codec de référence (Y-08 critères 1 à 3)', () => {
  const place: RecordPlace = { kind: 'j', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, segment: 2, index: 5 };
  const json = '{"k":"ops","sv":14,"ops":[{"t":"task","id":"x","title":"Acheter du pain"}]}';

  it('deux chiffrements du même texte donnent deux lignes différentes, toutes deux lisibles', async () => {
    const a = await sealRecord({ key, place, json, sm: 1, sv: 14 });
    const b = await sealRecord({ key, place, json, sm: 1, sv: 14 });
    expect(a).not.toBe(b);
    expect((await openRecord(key, place, a))?.json).toBe(json);
    expect((await openRecord(key, place, b))?.json).toBe(json);
  });

  it('enregistrement déplacé, réordonné, recopié ailleurs, ou sm / sv changés : refusé', async () => {
    const line = await sealRecord({ key, place, json, sm: 1, sv: 14 });
    const moved: RecordPlace[] = [
      { ...place, segment: 3 },
      { ...place, index: 4 },
      { ...place, dev: VECTOR_OTHER_DEVICE },
      { ...place, epoch: `e0002-${VECTOR_DEVICE}` },
      { kind: 's', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, seq: 2, index: 5 },
    ];
    for (const other of moved) expect(await openRecord(key, other, line)).toBeNull();
    expect(await openRecord(key, place, line.replace(/^1\.14\./, '1.15.'))).toBeNull();
    expect(await openRecord(key, place, line.replace(/^1\.14\./, '2.14.'))).toBeNull();
    const otherKey = vectorKey().map((b) => b ^ 1) as Uint8Array<ArrayBuffer>;
    expect(await openRecord(otherKey, place, line)).toBeNull();
  });

  it('état d’une autre époque ou d’un autre stateSeq : refusé', async () => {
    const state: RecordPlace = { kind: 'state', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, stateSeq: 7 };
    const line = await sealRecord({ key, place: state, json: '{}', sm: 1, sv: 14 });
    expect(await openRecord(key, state, line)).not.toBeNull();
    expect(await openRecord(key, { ...state, stateSeq: 8 }, line)).toBeNull();
    expect(await openRecord(key, { ...state, epoch: `e0002-${VECTOR_DEVICE}` }, line)).toBeNull();
  });

  it('les octets d’un fichier chiffré ne contiennent ni le titre ni un nom de table', async () => {
    // Nonce fixe : résultat déterministe (une suite base64 aléatoire pourrait contenir un mot court par hasard).
    const lines = [await sealRecord({ key, place, json, sm: 1, sv: 14, nonce: fromHex('0102030405060708090a0b0c') })];
    const text = fileText({ f: 'ct-j', sm: 1, kid: vectors.kid, dev: VECTOR_DEVICE, e: VECTOR_EPOCH, n: 2 }, lines);
    for (const secret of ['Acheter du pain', 'task', 'ops']) expect(text).not.toContain(secret);
  });

  it('texte du QR : aller-retour, clés exactes', () => {
    const content = { key, deviceId: VECTOR_DEVICE, epoch: VECTOR_EPOCH, expiresAt: 1_790_000_000_000 };
    expect(qrTextOf(content)).toBe(vectors.qr.text);
    expect(parseQrText(vectors.qr.text)).toEqual(content);
    expect(parseQrText(vectors.qr.text.slice(0, -2))).toBeNull();
    expect(parseQrText('CTPAIR2.' + vectors.qr.text.slice(8))).toBeNull();
  });
});
