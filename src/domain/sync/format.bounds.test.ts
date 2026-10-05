import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../types';
import {
  MAX_HEADER_BYTES,
  MAX_PADDED_PLAINTEXT_BYTES,
  MAX_RECORD_LINE_BYTES,
  MAX_RECORD_PLAINTEXT_BYTES,
  MAX_STATE_FILE_BYTES,
  NONCE_BYTES,
  PADDING_BLOCK_BYTES,
  TAG_BYTES,
  base64UrlLength,
  compareEpochs,
  encryptedLineBytes,
  epochId,
  isEpochId,
  isFileNumber,
  isDeviceAck,
  isKid,
  isSealedPayloadLength,
  isStrictHlc,
  isSyncDeviceId,
  paddedPlaintextBytes,
  parseFileHeader,
  parseRecordLinePrefix,
  parseSyncFileName,
  publishedStateFromJson,
  publishedStateToJson,
  utf8Bytes,
  type DeviceAck,
  type PublishedDeviceState,
} from './format';

/**
 * Compléments QA (ADR 0011, sections 1.1, 1.2, 1.4, 1.6, 12) : bornes exactes (limite et limite + 1) et entrées hostiles des
 * validateurs du format de synchro. Complète format.test.ts et limits.test.ts sans les répéter.
 */

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const KID = '0123456789abcdef';
const E1 = epochId(1, A);
const hlc = (ms: number, dev: string = A): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const header = (over: Record<string, unknown> = {}): string => JSON.stringify({ f: 'ct-j', sm: 1, kid: KID, dev: A, e: E1, n: 1, ...over });
const ack = (over: Partial<DeviceAck> = {}): DeviceAck => ({ epoch: E1, segment: 1, record: 2, hlc: hlc(10), stateSeq: 3, ...over });
const state = (over: Partial<PublishedDeviceState> = {}): PublishedDeviceState => ({
  deviceId: A,
  platform: 'windows',
  appVersion: '0.1.1',
  sm: 1,
  sv: 14,
  epoch: E1,
  stateSeq: 3,
  head: ack(),
  acks: new Map([[B, ack({ hlc: hlc(5, B), stateSeq: 7 })]]),
  snapshot: { seq: 1, endHlc: hlc(9) },
  purgeHorizon: null,
  lastSyncHlc: hlc(12),
  forgotten: [],
  reset: null,
  ...over,
});
const json = (s: PublishedDeviceState = state()): Record<string, unknown> => JSON.parse(JSON.stringify(publishedStateToJson(s))) as Record<string, unknown>;

describe('en-tête : bornes exactes et entrées hostiles (section 1.2)', () => {
  it('1 Kio exactement accepté, 1 Kio + 1 octet refusé', () => {
    const base = header();
    const exact = base + ' '.repeat(MAX_HEADER_BYTES - utf8Bytes(base));
    expect(utf8Bytes(exact)).toBe(MAX_HEADER_BYTES);
    expect(parseFileHeader(exact)).not.toBeNull();
    expect(parseFileHeader(exact + ' ')).toBeNull();
  });

  it('zéros de tête, signes, exposants et décimales refusés sur sm et n', () => {
    for (const bad of ['01', '-1', '+1', '1.0', '1.5', '1e0', '1E0', '1e+0', '0x1', '1e400', '-0', '00', '1_0']) {
      expect(parseFileHeader(header().replace('"n":1', `"n":${bad}`)), `n=${bad}`).toBeNull();
      expect(parseFileHeader(header().replace('"sm":1', `"sm":${bad}`)), `sm=${bad}`).toBeNull();
    }
  });

  it('nombres en chaîne, booléens, null et tableaux refusés', () => {
    for (const bad of ['"1"', 'true', 'null', '[1]', '{}']) {
      expect(parseFileHeader(header().replace('"n":1', `"n":${bad}`)), `n=${bad}`).toBeNull();
      expect(parseFileHeader(header().replace('"sm":1', `"sm":${bad}`)), `sm=${bad}`).toBeNull();
    }
  });

  it('n : bornes par type de fichier (segment 8 chiffres, stateSeq entier sûr)', () => {
    expect(parseFileHeader(header({ n: 99_999_999 }))?.n).toBe(99_999_999);
    expect(parseFileHeader(header({ n: 100_000_000 }))).toBeNull();
    expect(parseFileHeader(header({ f: 'ct-s', n: 99_999_999 }))?.n).toBe(99_999_999);
    expect(parseFileHeader(header({ f: 'ct-s', n: 100_000_000 }))).toBeNull();
    expect(parseFileHeader(header({ f: 'ct-state', n: Number.MAX_SAFE_INTEGER }))?.n).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseFileHeader(header({ f: 'ct-state' }).replace('"n":1', '"n":9007199254740993'))).toBeNull();
    expect(parseFileHeader(header({ f: 'ct-state', n: 0 }))).toBeNull();
  });

  it('clés répétées (toute clé, y compris échappée), clés inconnues et clés héritées refusées', () => {
    for (const key of ['f', 'sm', 'kid', 'dev', 'e', 'n']) {
      const value = (JSON.parse(header()) as Record<string, unknown>)[key];
      expect(parseFileHeader(header().replace('{', `{${JSON.stringify(key)}:${JSON.stringify(value)},`)), `répétée ${key}`).toBeNull();
    }
    expect(parseFileHeader(header().replace('{', '{"\\u006e":1,'))).toBeNull(); // « n » écrit « n » : répétée
    expect(parseFileHeader(header({ constructor: 1 }))).toBeNull();
    expect(parseFileHeader(header({ prototype: 1 }))).toBeNull();
    expect(parseFileHeader(header({ K: 1 }))).toBeNull();
  });

  it('sm : toute valeur >= 1 est lue (la majeure plus récente se décide plus haut, Y-07)', () => {
    expect(parseFileHeader(header({ sm: 2 }))?.sm).toBe(2);
    expect(parseFileHeader(header({ sm: 999_999 }))?.sm).toBe(999_999);
  });

  it('entrées vides ou non JSON refusées', () => {
    for (const bad of ['', ' ', 'null', 'true', '1', '"x"', '{}', '{"f":}', "{'f':'ct-j'}"]) expect(parseFileHeader(bad), bad).toBeNull();
  });

});

describe('identifiants et noms : bornes exactes et hostiles (section 1.1)', () => {
  it('numéros d’époque : 1 et 9999 valides, 0 et 10 000 refusés, NaN et décimaux refusés', () => {
    expect(epochId(1, A)).toBe(`e0001-${A}`);
    expect(epochId(9_999, A)).toBe(`e9999-${A}`);
    for (const n of [0, -1, 10_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => epochId(n, A), String(n)).toThrow(RangeError);
  });

  it('isEpochId : saut de ligne final, majuscule, 5 chiffres, UUID non v4 refusés', () => {
    expect(isEpochId(`e0001-${A}\n`)).toBe(false);
    expect(isEpochId(`E0001-${A}`)).toBe(false);
    expect(isEpochId(`e00001-${A}`)).toBe(false);
    expect(isEpochId(`e0001-${String(A).replace('-4', '-1')}`)).toBe(false);
    expect(isEpochId(`e0001-${String(A).toUpperCase()}`)).toBe(false);
    expect(isEpochId(`e9999-${A}`)).toBe(true);
  });

  it('compareEpochs : ordre total (antisymétrie, transitivité) sur numéros et ouvreurs', () => {
    const list = [epochId(1, A), epochId(1, B), epochId(2, A), epochId(2, B), epochId(10, A)];
    for (const x of list) {
      for (const y of list) expect(Math.sign(compareEpochs(x, y)) + Math.sign(compareEpochs(y, x))).toBe(0);
    }
    expect([...list].reverse().sort(compareEpochs)).toEqual(list);
  });

  it('UUID : variantes 8, 9, a, b valides ; c refusée ; version 4 seulement', () => {
    for (const v of ['8', '9', 'a', 'b']) expect(isSyncDeviceId(`0f8fad5b-d9cb-469f-${v}165-70867728950e`)).toBe(true);
    expect(isSyncDeviceId('0f8fad5b-d9cb-469f-c165-70867728950e')).toBe(false);
    expect(isSyncDeviceId(`${A}\n`)).toBe(false);
    expect(isSyncDeviceId(` ${A}`)).toBe(false);
    expect(isSyncDeviceId(String(A).replace(/-/g, ''))).toBe(false);
  });

  it('hlc : 15 chiffres exactement, saut de ligne, 4 hexa exactement', () => {
    expect(isStrictHlc(`0000000000000010-0000-${A}`)).toBe(false); // 16 chiffres
    expect(isStrictHlc(`${hlc(1)}\n`)).toBe(false);
    expect(isStrictHlc(`000000000000001-000-${A}`)).toBe(false);
    expect(isStrictHlc(`000000000000001-00000-${A}`)).toBe(false);
    expect(isStrictHlc(`000000000000001-ffff-${A}`)).toBe(true);
    expect(isStrictHlc(`000000000000001-FFFF-${A}`)).toBe(false);
  });

  it('kid : 15 et 17 caractères refusés, saut de ligne refusé', () => {
    expect(isKid('0'.repeat(15))).toBe(false);
    expect(isKid('0'.repeat(17))).toBe(false);
    expect(isKid(`${KID}\n`)).toBe(false);
    expect(isKid(KID)).toBe(true);
  });

  it('isFileNumber : bornes et types', () => {
    expect(isFileNumber(1)).toBe(true);
    expect(isFileNumber(99_999_999)).toBe(true);
    for (const v of [0, -1, 100_000_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, undefined]) expect(isFileNumber(v), String(v)).toBe(false);
  });

  it('noms de fichier : bornes de numéro, saut de ligne, chiffres hors ASCII, casse', () => {
    expect(parseSyncFileName('j-99999999.ctj')).toEqual({ kind: 'segment', n: 99_999_999 });
    expect(parseSyncFileName('s-99999999.cts')).toEqual({ kind: 'snapshot', n: 99_999_999 });
    for (const name of ['j-100000000.ctj', 'j-00000001.ctj\n', 'j-0000000١.ctj', 's-00000000.cts', 'State.ctx', 'state.ctx ', ' state.ctx', 'j-00000001.CTJ', 's-00000001.ctj', '', '.', '..', 'j-00000001.ctj/x']) {
      expect(parseSyncFileName(name), name).toBeNull();
    }
  });
});

describe('ligne chiffrée et bourrage : bornes exactes (section 1.2, audit M1)', () => {
  const chars = (padded: number): number => base64UrlLength(NONCE_BYTES + padded + TAG_BYTES);

  it('plus petite et plus grande charge valides ; un caractère de moins ou de plus refusé', () => {
    const smallest = chars(PADDING_BLOCK_BYTES);
    const largest = chars(MAX_PADDED_PLAINTEXT_BYTES);
    expect(isSealedPayloadLength(smallest)).toBe(true);
    expect(isSealedPayloadLength(largest)).toBe(true);
    for (const c of [smallest - 2, smallest - 1, smallest + 1, largest - 2, largest - 1, largest + 1, largest + 2, largest + 3]) {
      expect(isSealedPayloadLength(c), String(c)).toBe(false);
    }
  });

  it('chaque palier de 4 Kio valide, chaque valeur intermédiaire refusée (jusqu’à 12 paliers)', () => {
    for (let k = 1; k <= 12; k += 1) {
      expect(isSealedPayloadLength(chars(k * PADDING_BLOCK_BYTES)), `palier ${String(k)}`).toBe(true);
      expect(isSealedPayloadLength(chars(k * PADDING_BLOCK_BYTES) - 1), `palier ${String(k)} - 1`).toBe(false);
    }
  });

  it('types hostiles : NaN, infini, négatif, décimal refusés sans lever', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1, 5499.5, 0]) expect(isSealedPayloadLength(v), String(v)).toBe(false);
  });

  it('sm et sv : 6 chiffres au plus, 1 à 999 999', () => {
    const payload = 'A'.repeat(chars(PADDING_BLOCK_BYTES));
    expect(parseRecordLinePrefix(`999999.999999.${payload}`)).toEqual({ sm: 999_999, sv: 999_999, payload });
    expect(parseRecordLinePrefix(`1000000.1.${payload}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.1000000.${payload}`)).toBeNull();
    expect(parseRecordLinePrefix(`-1.1.${payload}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.1.5.${payload}`)).toBeNull();
    expect(parseRecordLinePrefix(`1e0.1.${payload}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.1.${payload}\n`)).toBeNull();
    expect(parseRecordLinePrefix(` 1.1.${payload}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.1.${payload}=`)).toBeNull(); // pas de remplissage base64
    expect(parseRecordLinePrefix('1.1.')).toBeNull();
    expect(parseRecordLinePrefix('')).toBeNull();
  });

  it('une ligne d’exactement 360 000 caractères avec une charge de longueur invalide : refusée', () => {
    expect(parseRecordLinePrefix(`1.1.${'A'.repeat(MAX_RECORD_LINE_BYTES - 4)}`)).toBeNull();
  });

  it('la plus grande ligne valide (sm et sv à 6 chiffres) tient dans 360 000 caractères et est acceptée', () => {
    const payload = 'A'.repeat(chars(MAX_PADDED_PLAINTEXT_BYTES));
    const line = `999999.999999.${payload}`;
    expect(line.length).toBeLessThanOrEqual(MAX_RECORD_LINE_BYTES);
    expect(parseRecordLinePrefix(line)).not.toBeNull();
  });

  it('bourrage : bornes autour des multiples de 4 Kio et du maximum', () => {
    expect(paddedPlaintextBytes(MAX_RECORD_PLAINTEXT_BYTES - 4)).toBe(MAX_RECORD_PLAINTEXT_BYTES);
    expect(paddedPlaintextBytes(MAX_RECORD_PLAINTEXT_BYTES - 3)).toBe(MAX_PADDED_PLAINTEXT_BYTES);
    expect(paddedPlaintextBytes(MAX_RECORD_PLAINTEXT_BYTES)).toBe(MAX_PADDED_PLAINTEXT_BYTES);
    expect(paddedPlaintextBytes(MAX_PADDED_PLAINTEXT_BYTES - 4)).toBe(MAX_PADDED_PLAINTEXT_BYTES);
    expect(paddedPlaintextBytes(MAX_PADDED_PLAINTEXT_BYTES - 3)).toBeGreaterThan(MAX_PADDED_PLAINTEXT_BYTES);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, -0.5]) expect(() => paddedPlaintextBytes(bad), String(bad)).toThrow(RangeError);
  });

  it('encryptedLineBytes : valeur exacte du plus petit enregistrement et de l’enregistrement maximal', () => {
    // 12 + 4096 + 16 = 4124 octets scellés -> 5499 caractères ; « 1.1. » = 4 ; « \n » = 1.
    expect(encryptedLineBytes(0, 1, 1)).toBe(5499 + 4 + 1);
    expect(encryptedLineBytes(MAX_RECORD_PLAINTEXT_BYTES, 1, 14)).toBe(chars(MAX_PADDED_PLAINTEXT_BYTES) + '1.14.'.length + 1);
    expect(encryptedLineBytes(0, 10, 100)).toBe(encryptedLineBytes(0, 1, 1) + 3); // chiffres de sm et sv comptés
  });

  it('état publié : borne de lecture = en-tête + ligne maximale + deux \\n', () => {
    expect(MAX_STATE_FILE_BYTES).toBe(MAX_HEADER_BYTES + 1 + MAX_RECORD_LINE_BYTES + 1);
  });

  it('utf8Bytes : paire de substitution isolée comptée comme U+FFFD (3 octets), jamais plus que la longueur réelle écrite', () => {
    expect(utf8Bytes('\ud800')).toBe(3);
    expect(utf8Bytes('')).toBe(0);
  });
});

describe('état publié : bornes exactes et entrées hostiles (section 1.4)', () => {
  const ids = (n: number): DeviceId[] => Array.from({ length: n }, (_, i) => `${String(i).padStart(8, '0')}-d9cb-469f-a165-70867728950e` as DeviceId);

  it('exactement 64 appareils oubliés acceptés, 65 refusés', () => {
    const forgotten = (n: number): PublishedDeviceState['forgotten'] => ids(n).map((deviceId) => ({ deviceId, at: hlc(1), lastAck: null }));
    expect(publishedStateFromJson(json(state({ forgotten: forgotten(64) })))).not.toBeNull();
    expect(publishedStateFromJson(json(state({ forgotten: forgotten(65) })))).toBeNull();
  });

  it('appVersion : 1 à 64 caractères ASCII sans espace', () => {
    const base = json();
    expect(publishedStateFromJson({ ...base, appVersion: 'a'.repeat(64) })).not.toBeNull();
    expect(publishedStateFromJson({ ...base, appVersion: 'a'.repeat(65) })).toBeNull();
    for (const v of ['', ' ', '1.0\n', '1.0 ', 'é', '1/0', 5, null]) expect(publishedStateFromJson({ ...base, appVersion: v }), String(v)).toBeNull();
    expect(publishedStateFromJson({ ...base, appVersion: '0.1.1-beta.2+build5' })).not.toBeNull();
  });

  it('compteurs : 0, négatifs, décimaux, NaN, infini et entiers non sûrs refusés où 1 est le minimum', () => {
    const base = json();
    for (const field of ['sm', 'sv', 'stateSeq']) {
      for (const v of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        expect(publishedStateFromJson({ ...base, [field]: v }), `${field}=${String(v)}`).toBeNull();
      }
    }
  });

  it('accusé : record et segment valent 0 au minimum ; non sûr, décimal, négatif refusés', () => {
    expect(isDeviceAck(ack({ segment: 0, record: 0, stateSeq: 0 }))).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isDeviceAck(ack({ segment: bad })), `segment ${String(bad)}`).toBe(false);
      expect(isDeviceAck(ack({ record: bad })), `record ${String(bad)}`).toBe(false);
      expect(isDeviceAck(ack({ stateSeq: bad })), `stateSeq ${String(bad)}`).toBe(false);
    }
    expect(isDeviceAck(ack({ epoch: 'e1' as never }))).toBe(false);
  });

  it('clés héritées ou interdites (constructor, prototype, __proto__) à tout niveau : état refusé', () => {
    const base = json();
    expect(publishedStateFromJson({ ...base, constructor: 1 })).toBeNull();
    expect(publishedStateFromJson({ ...base, prototype: 1 })).toBeNull();
    expect(publishedStateFromJson(JSON.parse(JSON.stringify(base).replace('{', '{"__proto__":{"x":1},')))).toBeNull();
    expect(publishedStateFromJson({ ...base, head: { ...ack(), constructor: 1 } })).toBeNull();
    expect(publishedStateFromJson({ ...base, snapshot: { seq: 1, endHlc: hlc(9), prototype: 1 } })).toBeNull();
    expect(publishedStateFromJson(JSON.parse(JSON.stringify(base).replace('"stateSeq":7', '"__proto__":1,"stateSeq":7')))).toBeNull();
  });

  it('types racines hostiles : null, tableau, nombre, chaîne, undefined', () => {
    for (const v of [null, undefined, [], [json()], 1, 'x', true]) expect(publishedStateFromJson(v), String(v)).toBeNull();
  });

  it('valeurs nulles à la place d’objets ou de listes refusées', () => {
    const base = json();
    for (const field of ['head', 'acks', 'forgotten', 'epoch', 'deviceId', 'lastSyncHlc']) {
      expect(publishedStateFromJson({ ...base, [field]: null }), field).toBeNull();
    }
    expect(publishedStateFromJson({ ...base, pairedBy: null })).toBeNull();
    expect(publishedStateFromJson({ ...base, forgotten: {} })).toBeNull();
    expect(publishedStateFromJson({ ...base, forgotten: [null] })).toBeNull();
    expect(publishedStateFromJson({ ...base, acks: { [B]: null } })).toBeNull();
  });

  it('snapshot : seq 1 à 99 999 999, clé en trop refusée', () => {
    const base = json();
    expect(publishedStateFromJson({ ...base, snapshot: { seq: 99_999_999, endHlc: hlc(9) } })).not.toBeNull();
    expect(publishedStateFromJson({ ...base, snapshot: { seq: 100_000_000, endHlc: hlc(9) } })).toBeNull();
    expect(publishedStateFromJson({ ...base, snapshot: { seq: 1, endHlc: hlc(9), extra: 1 } })).toBeNull();
    expect(publishedStateFromJson({ ...base, snapshot: { seq: 1 } })).toBeNull();
  });

  it('purgeHorizon : hlc strict ou null', () => {
    const base = json();
    expect(publishedStateFromJson({ ...base, purgeHorizon: hlc(4) })).not.toBeNull();
    expect(publishedStateFromJson({ ...base, purgeHorizon: `${hlc(4)}\n` })).toBeNull();
    expect(publishedStateFromJson({ ...base, purgeHorizon: undefined })).toBeNull();
  });

  it('un appareil oublié avec un lastAck invalide refuse l’état', () => {
    const base = json();
    expect(publishedStateFromJson({ ...base, forgotten: [{ deviceId: B, at: hlc(3), lastAck: { ...ack(), extra: 1 } }] })).toBeNull();
    expect(publishedStateFromJson({ ...base, forgotten: [{ deviceId: B, at: hlc(3), lastAck: ack() }] })).not.toBeNull();
  });

  it('l’état analysé ne partage aucun objet modifiable avec l’entrée (acks copiés dans une Map)', () => {
    const base = json();
    const parsed = publishedStateFromJson(base);
    expect(parsed?.acks).toBeInstanceOf(Map);
    expect(Object.getPrototypeOf(base['acks'])).toBe(Object.prototype);
    expect(parsed?.acks.get(B)?.stateSeq).toBe(7);
  });

  it('sérialisation : clés des accusés triées quel que soit l’ordre d’insertion ; texte identique', () => {
    const ordered = new Map<DeviceId, DeviceAck>([[A, ack()], [B, ack()]]);
    const reversed = new Map<DeviceId, DeviceAck>([[B, ack()], [A, ack()]]);
    expect(JSON.stringify(publishedStateToJson(state({ acks: ordered })))).toBe(JSON.stringify(publishedStateToJson(state({ acks: reversed }))));
    expect(Object.keys(publishedStateToJson(state({ acks: reversed })).acks)).toEqual([A, B]);
  });
});
