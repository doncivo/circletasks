import { describe, expect, it } from 'vitest';
import {
  base64UrlLength,
  encryptedLineBytes,
  GIB,
  KIB,
  MAX_APPEND_CALL_BYTES,
  MAX_CONFLICT_LOG_ROWS,
  MAX_DEVICE_FOLDERS,
  MAX_HEADER_BYTES,
  MAX_PADDED_PLAINTEXT_BYTES,
  MAX_PARKED_OPS,
  MAX_RECORD_LINE_BYTES,
  MAX_RECORD_PLAINTEXT_BYTES,
  MAX_SCAN_ENTRIES_PER_FOLDER,
  MAX_SEGMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_STATE_ACKS,
  MAX_STATE_FILE_BYTES,
  MAX_STATE_FORGOTTEN,
  MAX_UNKNOWN_BYTES,
  MAX_UNKNOWN_FIELDS,
  MIB,
  FOLDER_STOP_BYTES,
  FOLDER_WARN_BYTES,
  HLC_MAX_DRIFT_MS,
  PAIRING_VALIDITY_MS,
  paddedPlaintextBytes,
  SEGMENT_ROTATE_BYTES,
  SYNC_INTERVAL_MS,
  utf8Bytes,
} from './limits';
import { isSealedPayloadLength } from './format';

/** Bornes de la synchro (ADR 0011, section 1.6) : valeurs de l'ADR et cohérence des calculs de taille. */

describe('valeurs de la section 1.6', () => {
  it('reprend le tableau des bornes', () => {
    expect(MAX_HEADER_BYTES).toBe(1024);
    expect(MAX_RECORD_LINE_BYTES).toBe(360_000);
    expect(MAX_RECORD_PLAINTEXT_BYTES).toBe(256 * KIB);
    expect(MAX_STATE_FILE_BYTES).toBe(1024 + 1 + 360_000 + 1);
    expect(MAX_APPEND_CALL_BYTES).toBe(MIB);
    expect(SEGMENT_ROTATE_BYTES).toBe(MIB);
    expect(MAX_SCAN_ENTRIES_PER_FOLDER).toBe(10_000);
    expect(MAX_STATE_ACKS).toBe(64);
    expect(MAX_STATE_FORGOTTEN).toBe(64);
    expect(MAX_SEGMENT_BYTES).toBe(8 * MIB);
    expect(MAX_SNAPSHOT_BYTES).toBe(256 * MIB);
    expect(FOLDER_WARN_BYTES).toBe(GIB);
    expect(FOLDER_STOP_BYTES).toBe(4 * GIB);
    expect(MAX_DEVICE_FOLDERS).toBe(16);
    expect(MAX_PARKED_OPS).toBe(10_000);
    expect(MAX_UNKNOWN_FIELDS).toBe(50_000);
    expect(MAX_UNKNOWN_BYTES).toBe(16 * MIB);
    expect(MAX_CONFLICT_LOG_ROWS).toBe(10_000);
  });

  it('délais des sections 4.4, 10.1 et 10.3', () => {
    expect(HLC_MAX_DRIFT_MS).toBe(3_600_000);
    expect(SYNC_INTERVAL_MS).toBe(300_000);
    expect(PAIRING_VALIDITY_MS).toBe(300_000);
  });
});

describe('tailles calculées', () => {
  it('utf8Bytes compte les octets, pas les caractères', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('😀')).toBe(4);
  });

  it('bourrage au multiple de 4 Kio supérieur, 4 Kio au minimum (audit M1)', () => {
    expect(paddedPlaintextBytes(0)).toBe(4096);
    expect(paddedPlaintextBytes(4092)).toBe(4096);
    expect(paddedPlaintextBytes(4093)).toBe(8192);
    expect(paddedPlaintextBytes(MAX_RECORD_PLAINTEXT_BYTES)).toBe(MAX_PADDED_PLAINTEXT_BYTES);
    expect(() => paddedPlaintextBytes(-1)).toThrow(RangeError);
    expect(() => paddedPlaintextBytes(1.5)).toThrow(RangeError);
  });

  it('base64url sans remplissage', () => {
    expect(base64UrlLength(0)).toBe(0);
    expect(base64UrlLength(1)).toBe(2);
    expect(base64UrlLength(2)).toBe(3);
    expect(base64UrlLength(3)).toBe(4);
  });

  it('la plus longue ligne possible tient dans la borne de 360 000 octets', () => {
    const longest = encryptedLineBytes(MAX_RECORD_PLAINTEXT_BYTES, 999_999, 999_999) - 1; // sans le \n
    expect(longest).toBeLessThanOrEqual(MAX_RECORD_LINE_BYTES);
  });

  it('un lot ordinaire occupe une ligne de même taille (une tâche ou dix)', () => {
    expect(encryptedLineBytes(200, 1, 14)).toBe(encryptedLineBytes(3000, 1, 14));
    expect(encryptedLineBytes(5000, 1, 14)).toBeGreaterThan(encryptedLineBytes(3000, 1, 14));
  });

  it('toute ligne produite a une charge de longueur valide', () => {
    for (const json of [0, 1, 4092, 4093, 100_000, MAX_RECORD_PLAINTEXT_BYTES]) {
      const payload = encryptedLineBytes(json, 1, 14) - '1.14.'.length - 1;
      expect(isSealedPayloadLength(payload)).toBe(true);
    }
  });
});
