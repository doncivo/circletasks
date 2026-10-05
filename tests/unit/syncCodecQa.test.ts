// Y-08 QA : entrées hostiles, bornes et parité du codec de référence avec Rust (src-tauri/tests/desktop/sync_qa_crypto.rs).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_RECORD_LINE_BYTES, MAX_RECORD_PLAINTEXT_BYTES, paddedPlaintextBytes } from '../../src/domain/sync/format';
import {
  fromBase64Url,
  fromHex,
  keyFromRecovery,
  openRecord,
  padPlaintext,
  parseQrText,
  qrTextOf,
  recoveryKeyOf,
  sealRecord,
  toBase64Url,
  unpadPlaintext,
  type RecordPlace,
} from '../sim/syncCodec';
import { VECTOR_DEVICE, VECTOR_EPOCH, type SyncVectors } from '../sim/syncVectors';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/sync/vectors.json', import.meta.url), 'utf8')) as SyncVectors;
const key = fromHex(vectors.key);
const place: RecordPlace = { kind: 'j', dev: VECTOR_DEVICE, epoch: VECTOR_EPOCH, segment: 1, index: 0 };

describe('Y-08 critère 1 : lignes hostiles (parité Rust)', () => {
  it('chaque région de la charge utile est authentifiée (nonce, texte chiffré, étiquette)', async () => {
    const line = await sealRecord({ key, place, json: '{"a":1}', sm: 1, sv: 14 });
    const decoded = fromBase64Url(line.slice('1.14.'.length));
    if (!decoded) throw new Error('ligne scellée illisible');
    const payload = decoded;
    for (const index of [0, 11, 12, 13, 2000, payload.length - 17, payload.length - 16, payload.length - 1]) {
      const tampered = payload.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      expect(await openRecord(key, place, `1.14.${toBase64Url(tampered)}`), `octet ${String(index)}`).toBeNull();
    }
    for (const length of [payload.length - 1, payload.length + 1]) {
      const changed = new Uint8Array(length);
      changed.set(payload.subarray(0, Math.min(length, payload.length)));
      expect(await openRecord(key, place, `1.14.${toBase64Url(changed)}`), `longueur ${String(length)}`).toBeNull();
    }
  });

  it('formes de ligne invalides refusées sans exception', async () => {
    const line = await sealRecord({ key, place, json: '{}', sm: 1, sv: 14 });
    const body = line.slice('1.14.'.length);
    const cases: Record<string, string> = {
      vide: '',
      point: '.',
      'sans charge utile': '1.14',
      'charge utile vide': '1.14.',
      'retour à la ligne': `${line}\n`,
      'espace final': `${line} `,
      remplissage: `${line}=`,
      'alphabet standard': `1.14.${body.replace(/-/g, '+')}`,
      'non ASCII': `1.14.${body.slice(0, -1)}é`,
      tronquée: `1.14.${body.slice(0, -4)}`,
      'champ en trop': `1.14.${body}.extra`,
      'sm nul': `0.14.${body}`,
      'sv nul': `1.0.${body}`,
      'zéro initial': `1.014.${body}`,
      signe: `1.+14.${body}`,
      'sv négatif': `1.-1.${body}`,
      'sm de 7 chiffres': `1234567.14.${body}`,
      'trop longue': `1.14.${'A'.repeat(MAX_RECORD_LINE_BYTES + 1)}`,
    };
    for (const [why, text] of Object.entries(cases)) expect(await openRecord(key, place, text), why).toBeNull();
    expect(await openRecord(key, place, line)).not.toBeNull();
  });

  it('base64url canonique : la variante dont les bits de fin diffèrent est refusée', async () => {
    const line = await sealRecord({ key, place, json: '{}', sm: 1, sv: 14 });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = line.at(-1) ?? '';
    const variant = line.slice(0, -1) + (alphabet[alphabet.indexOf(last) ^ 1] ?? '');
    expect(variant).not.toBe(line);
    expect(await openRecord(key, place, variant)).toBeNull();
    expect(fromBase64Url('AA')).not.toBeNull();
    expect(fromBase64Url('AB')).toBeNull();
    expect(fromBase64Url('A')).toBeNull();
    expect(fromBase64Url('AAAAA')).toBeNull();
  });
});

describe('Y-08 critère 2 : bourrage aux bornes', () => {
  it('paliers de 4 Kio', () => {
    expect([0, 1, 4092, 4093, MAX_RECORD_PLAINTEXT_BYTES].map(paddedPlaintextBytes)).toEqual([4096, 4096, 4096, 8192, 266_240]);
    expect(unpadPlaintext(padPlaintext(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('cadres hostiles refusés', () => {
    expect(unpadPlaintext(new Uint8Array(0))).toBeNull();
    expect(unpadPlaintext(new Uint8Array(3))).toBeNull();
    expect(unpadPlaintext(new Uint8Array(4))).toBeNull();
    expect(unpadPlaintext(new Uint8Array(4095))).toBeNull();
    expect(unpadPlaintext(new Uint8Array(4097))).toBeNull();
    const frame = new Uint8Array(4096);
    const view = new DataView(frame.buffer);
    view.setUint32(0, 0xffffffff, false);
    expect(unpadPlaintext(frame)).toBeNull();
    view.setUint32(0, 4093, false);
    expect(unpadPlaintext(frame)).toBeNull();
    view.setUint32(0, 4092, false);
    expect(unpadPlaintext(frame)).not.toBeNull();
    const fat = new Uint8Array(8192);
    new DataView(fat.buffer).setUint32(0, 10, false);
    expect(unpadPlaintext(fat)).toBeNull();
  });

  it('tailles de texte clair aux bornes : aller-retour, taille masquée', async () => {
    const short = await sealRecord({ key, place, json: 'x', sm: 1, sv: 14 });
    const long = await sealRecord({ key, place, json: 'x'.repeat(4092), sm: 1, sv: 14 });
    expect(short.length).toBe(long.length);
    const max = await sealRecord({ key, place, json: 'a'.repeat(MAX_RECORD_PLAINTEXT_BYTES), sm: 1, sv: 14 });
    expect(max.length + 1).toBeLessThanOrEqual(MAX_RECORD_LINE_BYTES);
    expect((await openRecord(key, place, max))?.json.length).toBe(MAX_RECORD_PLAINTEXT_BYTES);
  });
});

describe('Y-08 critère 8 : clé de secours', () => {
  it('toute substitution d’un caractère est détectée (clé de test fixe)', async () => {
    const recovery = await recoveryKeyOf(key);
    const body = recovery.slice(4).replace(/-/g, '');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let accepted = 0;
    for (let i = 0; i < body.length; i += 1) {
      for (const c of alphabet) {
        if (c === body[i]) continue;
        const found = await keyFromRecovery(body.slice(0, i) + c + body.slice(i + 1));
        if (found) {
          expect(toHexOf(found)).not.toBe(vectors.key);
          accepted += 1;
        }
      }
    }
    expect(accepted).toBeLessThanOrEqual(2);
  });

  it('bits de bourrage non nuls et entrées hostiles refusés', async () => {
    const body = (await recoveryKeyOf(key)).slice(4).replace(/-/g, '');
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    expect(alphabet.indexOf(body.at(-1) ?? '') & 7).toBe(0);
    const variant = body.slice(0, -1) + (alphabet[alphabet.indexOf(body.at(-1) ?? '') | 1] ?? '');
    expect(await keyFromRecovery(variant)).toBeNull();
    for (const input of ['', 'CT1-', `CT2-${body}`, `${body}0`, body.slice(0, 54), `${body}${body}`, '😀'.repeat(20), '0'.repeat(55), body.replace(body[0] ?? '', 'U')]) {
      expect(await keyFromRecovery(input), input.slice(0, 12)).toBeNull();
    }
    expect(await keyFromRecovery(body)).not.toBeNull();
    expect(await keyFromRecovery(`ct1 ${body.toLowerCase()}`)).not.toBeNull();
  });
});

describe('Y-08 critère 14 : texte du QR aux bornes', () => {
  const content = { key, deviceId: VECTOR_DEVICE, epoch: VECTOR_EPOCH, expiresAt: 1_790_000_000_000 };
  const encode = (value: unknown): string => `CTPAIR1.${toBase64Url(new TextEncoder().encode(JSON.stringify(value)))}`;
  const base = { v: 1, k: toBase64Url(key), d: VECTOR_DEVICE, e: VECTOR_EPOCH, x: 1 };

  it('x : 2^53 - 1 accepté, 2^53, négatif, texte et fractionnaire refusés', () => {
    expect(parseQrText(encode({ ...base, x: Number.MAX_SAFE_INTEGER }))).not.toBeNull();
    expect(parseQrText(encode({ ...base, x: 0 }))).not.toBeNull();
    for (const x of [Number.MAX_SAFE_INTEGER + 1, -1, '1', 1.5, null]) expect(parseQrText(encode({ ...base, x })), String(x)).toBeNull();
  });

  it('époque, appareil, version et clé mal formés refusés', () => {
    expect(parseQrText(encode({ ...base, e: null }))).not.toBeNull();
    for (const patch of [
      { e: 'e0000-3f2b8c1e-5a7d-4e9b-9c2a-1b2c3d4e5f60' },
      { e: 1 },
      { d: (VECTOR_DEVICE as string).toUpperCase() },
      { d: null },
      { v: 0 },
      { v: 2 },
      { k: toBase64Url(new Uint8Array(31)) },
      { k: toBase64Url(new Uint8Array(33)) },
      { k: '' },
    ]) {
      expect(parseQrText(encode({ ...base, ...patch })), JSON.stringify(patch)).toBeNull();
    }
    for (const raw of ['null', '[]', '1', '"x"', '{}', '{']) expect(parseQrText(`CTPAIR1.${toBase64Url(new TextEncoder().encode(raw))}`), raw).toBeNull();
    expect(parseQrText('CTPAIR1.')).toBeNull();
    expect(parseQrText('')).toBeNull();
    expect(parseQrText(` ${qrTextOf(content)}`)).toBeNull();
    expect(parseQrText(`${qrTextOf(content)}\n`)).toBeNull();
    expect(parseQrText(`${qrTextOf(content)}${'A'.repeat(1024)}`)).toBeNull();
  });
});

/**
 * Défaut QA-Y1-4 (faible) : le codec de référence TypeScript est plus permissif que Rust sur des entrées exotiques. Rust (autorité de
 * production) refuse ; le codec TS accepte. Sans conséquence sur la production, mais les vecteurs croisés ne couvrent pas ces cas et
 * Y-02 s'appuie sur ce codec pour ses tests. Corrigé au lot Y1 (corrections revue et audit) : le codec refuse comme Rust.
 */
describe('Y-08 critère 4 : parité TS / Rust sur les entrées exotiques (défaut QA-Y1-4)', () => {
  it('clé de secours : espace insécable, « ı » et « ſ » (majuscules Unicode) refusés comme Rust ; plafond de 256 octets', async () => {
    const body = (await recoveryKeyOf(key)).slice(4).replace(/-/g, '');
    expect(await keyFromRecovery(`${body.slice(0, 10)}${String.fromCharCode(0xa0)}${body.slice(10)}`)).toBeNull();
    const withOne = body.replace('1', 'ı');
    if (withOne !== body) expect(await keyFromRecovery(withOne)).toBeNull();
    expect(await keyFromRecovery(`${' '.repeat(300)}${body}`)).toBeNull();
  });

  it('QR : clé répétée et x = 1.0 refusés comme Rust', () => {
    const k = toBase64Url(key);
    const duplicate = `{"v":1,"k":"${k}","k":"${k}","d":"${VECTOR_DEVICE}","e":null,"x":1}`;
    const text = (json: string): string => `CTPAIR1.${toBase64Url(new TextEncoder().encode(json))}`;
    expect(parseQrText(text(duplicate))).toBeNull();
    expect(parseQrText(text(`{"v":1,"k":"${k}","d":"${VECTOR_DEVICE}","e":null,"x":1.0}`))).toBeNull();
  });
});

function toHexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
