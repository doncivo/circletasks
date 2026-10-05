import { describe, expect, it } from 'vitest';
import { decodeTextBytes } from './textEncoding';

const utf16le = (text: string): number[] => [0xff, 0xfe, ...[...text].flatMap((char) => [char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8])];
const utf16be = (text: string): number[] => [0xfe, 0xff, ...[...text].flatMap((char) => [char.charCodeAt(0) >> 8, char.charCodeAt(0) & 0xff])];

describe('Décodage d’un fichier texte (P-07 critère 2)', () => {
  it('UTF-8 avec ou sans BOM', () => {
    const utf8 = new TextEncoder().encode('titre\nÉcole');
    expect(decodeTextBytes(utf8)).toBe('titre\nÉcole');
    expect(decodeTextBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe('titre\nÉcole');
  });

  it('repli Windows-1252 quand l’UTF-8 est invalide', () => {
    // « Réunion à 14 h » écrit par Excel en Windows-1252 (é = 0xE9, à = 0xE0).
    const bytes = Uint8Array.from([0x52, 0xe9, 0x75, 0x6e, 0x69, 0x6f, 0x6e, 0x20, 0xe0, 0x20, 0x31, 0x34, 0x20, 0x68]);
    expect(decodeTextBytes(bytes)).toBe('Réunion à 14 h');
  });

  it('BOM UTF-16 petit-boutiste et gros-boutiste (Excel « Unicode »)', () => {
    expect(decodeTextBytes(Uint8Array.from(utf16le('titre;date\nÉcole')))).toBe('titre;date\nÉcole');
    expect(decodeTextBytes(Uint8Array.from(utf16be('titre;date\nÉcole')))).toBe('titre;date\nÉcole');
  });

  it('un BOM UTF-8 suivi d’octets invalides ne laisse pas « ï»¿ » dans l’en-tête', () => {
    const decoded = decodeTextBytes(Uint8Array.from([0xef, 0xbb, 0xbf, 0x74, 0x69, 0x74, 0x72, 0x65, 0x3b, 0xe9]));
    expect(decoded).toBe('titre;é');
    expect(decoded.startsWith('titre')).toBe(true);
  });

  it('fichier vide', () => {
    expect(decodeTextBytes(new Uint8Array())).toBe('');
  });
});
