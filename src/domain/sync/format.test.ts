import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../types';
import {
  SYNC_ERROR_CODES,
  SYNC_FORMAT_MAJOR,
  SYNC_TABLE_ORDER,
  base64UrlLength,
  compareEpochs,
  epochId,
  headerMatchesPath,
  isDeviceAck,
  isEpochId,
  isFileNumber,
  isKid,
  isSealedPayloadLength,
  isStrictHlc,
  isSyncDeviceId,
  isSyncErrorCode,
  isUnknownName,
  isUnknownSettingKey,
  MAX_PADDED_PLAINTEXT_BYTES,
  MAX_RECORD_LINE_BYTES,
  NONCE_BYTES,
  parseEpochId,
  parseFileHeader,
  parseRecordLinePrefix,
  parseSyncFileName,
  publishedStateFromJson,
  publishedStateToJson,
  segmentFileName,
  snapshotFileName,
  TAG_BYTES,
  type DeviceAck,
  type PublishedDeviceState,
} from './format';

/** Format de la synchro (ADR 0011, sections 1.1, 1.2, 1.4, 3.1 et 11 ; Y-02, Y-07, Y-08). */

const A_TEXT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const A = A_TEXT as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const hlc = (ms: number, dev: string = A): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const E1 = epochId(1, A);
const KID = '0123456789abcdef';

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

const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('identifiants et noms stricts (section 1.1)', () => {
  it('device_id : UUID v4 en minuscules seulement', () => {
    expect(isSyncDeviceId(A)).toBe(true);
    expect(isSyncDeviceId(A_TEXT.toUpperCase())).toBe(false);
    expect(isSyncDeviceId('0f8fad5b-d9cb-169f-a165-70867728950e')).toBe(false); // v1
    expect(isSyncDeviceId(42)).toBe(false);
  });

  it('hlc strict validé avant toute comparaison (audit M4)', () => {
    expect(isStrictHlc(hlc(1))).toBe(true);
    expect(isStrictHlc(`00000000000001-0000-${A}`)).toBe(false); // 14 chiffres
    expect(isStrictHlc(`000000000000001-00G0-${A}`)).toBe(false);
    expect(isStrictHlc(`000000000000001-0000-${A_TEXT.toUpperCase()}`)).toBe(false);
    expect(isStrictHlc(null)).toBe(false);
  });

  it('kid : 16 hexadécimaux minuscules', () => {
    expect(isKid(KID)).toBe(true);
    expect(isKid(KID.toUpperCase())).toBe(false);
    expect(isKid('0123')).toBe(false);
  });

  it('époques : e<4 chiffres>-<uuid>, numéro 1 à 9999, ordre par numéro puis UUID', () => {
    expect(E1).toBe(`e0001-${A}`);
    expect(isEpochId(E1)).toBe(true);
    expect(isEpochId(`e0000-${A}`)).toBe(false);
    expect(isEpochId(`e1-${A}`)).toBe(false);
    expect(parseEpochId(epochId(12, B))).toEqual({ n: 12, opener: B });
    expect(parseEpochId(`e0000-${A}`)).toBeNull();
    expect(() => epochId(0, A)).toThrow(RangeError);
    expect(() => epochId(10_000, A)).toThrow(RangeError);
    expect(() => epochId(1, 'x' as DeviceId)).toThrow(TypeError);
    expect(compareEpochs(epochId(1, B), epochId(2, A))).toBeLessThan(0);
    expect(compareEpochs(epochId(2, A), epochId(2, B))).toBeLessThan(0); // 0f… < 7c…
    expect(compareEpochs(E1, E1)).toBe(0);
    expect(() => compareEpochs(E1, 'e9' as typeof E1)).toThrow(TypeError);
  });

  it('segments et instantanés : 8 chiffres, 1 à 99 999 999', () => {
    expect(segmentFileName(1)).toBe('j-00000001.ctj');
    expect(snapshotFileName(42)).toBe('s-00000042.cts');
    expect(() => segmentFileName(0)).toThrow(RangeError);
    expect(() => snapshotFileName(100_000_000)).toThrow(RangeError);
    expect(isFileNumber(1.5)).toBe(false);
  });

  it('noms reconnus ; copies de conflit, temporaires et state.next.ctx ignorés', () => {
    expect(parseSyncFileName('state.ctx')).toEqual({ kind: 'state' });
    expect(parseSyncFileName('j-00000003.ctj')).toEqual({ kind: 'segment', n: 3 });
    expect(parseSyncFileName('s-00000002.cts')).toEqual({ kind: 'snapshot', n: 2 });
    for (const name of ['state 2.ctx', 'state.ctx.tmp', 'state.next.ctx', 'j-00000000.ctj', 'j-1.ctj', 'J-00000001.ctj', 's-00000001.cts.tmp', 'notes.txt']) {
      expect(parseSyncFileName(name)).toBeNull();
    }
  });
});

describe('en-tête en clair (section 1.2)', () => {
  it('accepte exactement les six clés, espaces JSON compris', () => {
    expect(parseFileHeader(header())).toEqual({ f: 'ct-j', sm: 1, kid: KID, dev: A, e: E1, n: 1 });
    expect(parseFileHeader(header({ f: 'ct-state', n: 123_456_789_012 }))?.n).toBe(123_456_789_012);
    expect(parseFileHeader(header().replace(/,/g, ' , '))).not.toBeNull();
  });

  it('refuse clé en trop, clé manquante, clé répétée, __proto__', () => {
    expect(parseFileHeader(header({ x: 1 }))).toBeNull();
    expect(parseFileHeader(JSON.stringify({ f: 'ct-j', sm: 1, kid: KID, dev: A, e: E1 }))).toBeNull();
    expect(parseFileHeader(header().replace('{', '{"n":1,'))).toBeNull();
    expect(parseFileHeader(header().replace('"f":"ct-j"', '"__proto__":"ct-j"'))).toBeNull();
  });

  it('refuse types et valeurs hors schéma', () => {
    expect(parseFileHeader(header({ f: 'ct-x' }))).toBeNull();
    expect(parseFileHeader(header({ sm: 0 }))).toBeNull();
    expect(parseFileHeader(header().replace('"sm":1', '"sm":1.0'))).toBeNull();
    expect(parseFileHeader(header().replace('"n":1', '"n":1e0'))).toBeNull();
    expect(parseFileHeader(header({ n: 0 }))).toBeNull();
    expect(parseFileHeader(header({ n: 100_000_000 }))).toBeNull(); // segment sur 8 chiffres
    expect(parseFileHeader(header({ kid: KID.toUpperCase() }))).toBeNull();
    expect(parseFileHeader(header({ dev: 'pc' }))).toBeNull();
    expect(parseFileHeader(header({ e: 'e0001' }))).toBeNull();
    expect(parseFileHeader('[1]')).toBeNull();
    expect(parseFileHeader('{')).toBeNull();
    expect(parseFileHeader(String.fromCharCode(0xfeff) + header())).toBeNull();
  });

  it('refuse un en-tête de plus de 1 Kio', () => {
    expect(parseFileHeader(header() + ' '.repeat(1024))).toBeNull();
  });

  it("l'en-tête doit correspondre au chemin (audit B2)", () => {
    const h = parseFileHeader(header({ n: 4 }));
    if (!h) throw new Error('en-tête attendu');
    expect(headerMatchesPath(h, { deviceId: A, epoch: E1, file: { kind: 'segment', n: 4 } })).toBe(true);
    expect(headerMatchesPath(h, { deviceId: A, epoch: E1, file: { kind: 'segment', n: 5 } })).toBe(false);
    expect(headerMatchesPath(h, { deviceId: A, epoch: epochId(2, A), file: { kind: 'segment', n: 4 } })).toBe(false);
    expect(headerMatchesPath(h, { deviceId: B, epoch: E1, file: { kind: 'segment', n: 4 } })).toBe(false);
    expect(headerMatchesPath(h, { deviceId: A, epoch: E1, file: { kind: 'snapshot', n: 4 } })).toBe(false);
    const s = parseFileHeader(header({ f: 'ct-state', n: 9 }));
    if (!s) throw new Error('en-tête attendu');
    expect(headerMatchesPath(s, { deviceId: A, epoch: null, file: { kind: 'state' } })).toBe(true);
    expect(headerMatchesPath(s, { deviceId: A, epoch: E1, file: { kind: 'state' } })).toBe(true);
    expect(headerMatchesPath(s, { deviceId: A, epoch: epochId(2, B), file: { kind: 'state' } })).toBe(false);
    const snap = parseFileHeader(header({ f: 'ct-s', n: 2 }));
    if (!snap) throw new Error('en-tête attendu');
    expect(headerMatchesPath(snap, { deviceId: A, epoch: E1, file: { kind: 'snapshot', n: 2 } })).toBe(true);
  });
});

describe('ligne chiffrée (section 1.2, Y-07)', () => {
  const smallest = 'A'.repeat(base64UrlLength(NONCE_BYTES + 4096 + TAG_BYTES));
  const largest = 'A'.repeat(base64UrlLength(NONCE_BYTES + MAX_PADDED_PLAINTEXT_BYTES + TAG_BYTES));

  it('lit sm et sv en clair, avant tout déchiffrement', () => {
    expect(parseRecordLinePrefix(`1.14.${smallest}`)).toEqual({ sm: 1, sv: 14, payload: smallest });
    expect(parseRecordLinePrefix(`2.30.${largest}`)?.sm).toBe(2);
  });

  it('refuse entiers non canoniques, préfixe absent, caractères hors base64url', () => {
    expect(parseRecordLinePrefix(`01.14.${smallest}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.014.${smallest}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.0.${smallest}`)).toBeNull();
    expect(parseRecordLinePrefix(smallest)).toBeNull();
    expect(parseRecordLinePrefix(`1.14.${smallest.slice(1)}+`)).toBeNull();
  });

  it('refuse une longueur de charge incompatible avec le bourrage par 4 Kio', () => {
    expect(parseRecordLinePrefix(`1.14.${smallest.slice(4)}`)).toBeNull();
    expect(parseRecordLinePrefix(`1.14.AAAA`)).toBeNull();
    expect(isSealedPayloadLength(base64UrlLength(NONCE_BYTES + 8192 + TAG_BYTES))).toBe(true);
    expect(isSealedPayloadLength(base64UrlLength(NONCE_BYTES + 8000 + TAG_BYTES))).toBe(false);
    expect(isSealedPayloadLength(base64UrlLength(NONCE_BYTES + MAX_PADDED_PLAINTEXT_BYTES + 4096 + TAG_BYTES))).toBe(false);
    expect(isSealedPayloadLength(5)).toBe(false); // longueur ≡ 1 mod 4
    expect(isSealedPayloadLength(0)).toBe(false);
  });

  it('refuse une ligne trop longue sans l’analyser', () => {
    expect(parseRecordLinePrefix(`1.14.${'A'.repeat(MAX_RECORD_LINE_BYTES)}`)).toBeNull();
  });
});

describe('codes d’erreur (section 11.1)', () => {
  it('38 codes (35, plus not-foreground, already-open et window-unprotected de Y-06), sans doublon, reconnus par isSyncErrorCode', () => {
    expect(SYNC_ERROR_CODES).toHaveLength(38);
    expect(new Set(SYNC_ERROR_CODES).size).toBe(38);
    expect(isSyncErrorCode('segment-full')).toBe(true);
    expect(isSyncErrorCode('SEGMENT-FULL')).toBe(false);
    expect(isSyncErrorCode(undefined)).toBe(false);
  });
});

describe('état publié (section 1.4)', () => {
  it('accusé : exactement cinq clés, hlc strict ou null', () => {
    expect(isDeviceAck(ack())).toBe(true);
    expect(isDeviceAck(ack({ hlc: null }))).toBe(true);
    expect(isDeviceAck({ ...ack(), extra: 1 })).toBe(false);
    expect(isDeviceAck(ack({ record: -1 }))).toBe(false);
    expect(isDeviceAck(ack({ hlc: 'x' as Hlc }))).toBe(false);
    expect(isDeviceAck(null)).toBe(false);
  });

  it('aller-retour JSON : accusés en Map, clés triées, pairedBy facultatif', () => {
    const s = state({ pairedBy: B });
    const json = publishedStateToJson(s);
    expect(Object.getPrototypeOf(json.acks)).toBeNull();
    const back = publishedStateFromJson(roundTrip(json));
    expect(back).toEqual(s);
    expect(back?.acks).toBeInstanceOf(Map);
    const withoutPairing = publishedStateFromJson(roundTrip(publishedStateToJson(state())));
    expect(withoutPairing && 'pairedBy' in withoutPairing).toBe(false);
    expect(JSON.stringify(publishedStateToJson(state()))).toBe(JSON.stringify(publishedStateToJson(state())));
  });

  it('accepte les champs réservés de Y-10 et Y-11 (schéma prêt dès sm 1)', () => {
    const s = state({ forgotten: [{ deviceId: B, at: hlc(3), lastAck: null }], reset: { kid: KID, epoch: epochId(2, A), at: hlc(4) } });
    expect(publishedStateFromJson(roundTrip(publishedStateToJson(s)))).toEqual(s);
  });

  it('refuse clé manquante ou en trop, valeurs hors schéma', () => {
    const json = roundTrip(publishedStateToJson(state())) as Record<string, unknown>;
    const without = { ...json };
    delete without['reset'];
    expect(publishedStateFromJson(without)).toBeNull();
    expect(publishedStateFromJson({ ...json, extra: 1 })).toBeNull();
    expect(publishedStateFromJson({ ...json, platform: 'android' })).toBeNull();
    expect(publishedStateFromJson({ ...json, appVersion: '0.1 beta' })).toBeNull();
    expect(publishedStateFromJson({ ...json, stateSeq: 0 })).toBeNull();
    expect(publishedStateFromJson({ ...json, pairedBy: 'pc' })).toBeNull();
    expect(publishedStateFromJson({ ...json, snapshot: { seq: 0, endHlc: hlc(1) } })).toBeNull();
    expect(publishedStateFromJson({ ...json, purgeHorizon: 'x' })).toBeNull();
    expect(publishedStateFromJson({ ...json, lastSyncHlc: null })).toBeNull();
    expect(publishedStateFromJson({ ...json, reset: { kid: KID } })).toBeNull();
    expect(publishedStateFromJson({ ...json, forgotten: [{ deviceId: B }] })).toBeNull();
    expect(publishedStateFromJson({ ...json, acks: [] })).toBeNull();
    expect(publishedStateFromJson('état')).toBeNull();
  });

  it('la tête appartient à l’époque annoncée et porte le même stateSeq', () => {
    expect(publishedStateFromJson(roundTrip(publishedStateToJson(state({ head: ack({ epoch: epochId(2, A) }) }))))).toBeNull();
    expect(publishedStateFromJson(roundTrip(publishedStateToJson(state({ head: ack({ stateSeq: 2 }) }))))).toBeNull();
  });

  it('au plus 64 accusés et 64 appareils oubliés', () => {
    const ids = Array.from({ length: 65 }, (_, i) => `${String(i).padStart(8, '0')}-d9cb-469f-a165-70867728950e` as DeviceId);
    const many = new Map(ids.map((id) => [id, ack()] as const));
    expect(publishedStateFromJson(roundTrip(publishedStateToJson(state({ acks: new Map([...many].slice(0, 64)) }))))).not.toBeNull();
    expect(publishedStateFromJson(roundTrip(publishedStateToJson(state({ acks: many }))))).toBeNull();
    const forgotten = ids.map((deviceId) => ({ deviceId, at: hlc(1), lastAck: null }));
    expect(publishedStateFromJson(roundTrip(publishedStateToJson(state({ forgotten }))))).toBeNull();
  });

  it('un accusé indexé par __proto__ ou par un identifiant invalide refuse l’état (audit H5)', () => {
    const text = JSON.stringify(publishedStateToJson(state())).replace(`"${B}"`, '"__proto__"');
    expect(publishedStateFromJson(JSON.parse(text))).toBeNull();
    const json = roundTrip(publishedStateToJson(state())) as Record<string, unknown>;
    expect(publishedStateFromJson({ ...json, acks: { pc: ack() } })).toBeNull();
  });
});

describe('noms inconnus et ordre des tables (sections 3.3, 7.2, 8)', () => {
  it('noms de table ou de champ inconnus', () => {
    expect(isUnknownName('new_column')).toBe(true);
    expect(isUnknownName('NewColumn')).toBe(false);
    expect(isUnknownName('_x')).toBe(false);
    expect(isUnknownName('a'.repeat(64))).toBe(false);
  });

  it('clés de réglage inconnues', () => {
    expect(isUnknownSettingKey('theme.accent')).toBe(true);
    expect(isUnknownSettingKey('a.b.c.d')).toBe(true);
    expect(isUnknownSettingKey('a.b.c.d.e')).toBe(false);
    expect(isUnknownSettingKey('theme')).toBe(false);
    expect(isUnknownSettingKey('theme.__proto__')).toBe(false);
    expect(isUnknownSettingKey('a.constructor')).toBe(false);
  });

  it('16 tables publiées dans l’ordre topologique', () => {
    expect(SYNC_TABLE_ORDER).toHaveLength(16);
    expect(SYNC_TABLE_ORDER[0]).toBe('space');
    expect(SYNC_TABLE_ORDER.indexOf('task')).toBeLessThan(SYNC_TABLE_ORDER.indexOf('reminder'));
    expect(SYNC_FORMAT_MAJOR).toBe(1);
  });
});
