import { describe, expect, it } from 'vitest';
import {
  IMPORT_MAX_COLUMNS,
  IMPORT_REASON_VALUE_MAX,
  importFileName,
  normalizeName,
  parseImportFile,
  sanitizeLine,
  sanitizeNote,
  truncateValue,
  validateImportRows,
  type ImportContext,
} from './csvImport';
import { asEntityId } from './types';
import type { LocalDate, SpaceId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-0000000000a1');
const context: ImportContext = { spaces: [{ id: PRO, name: 'Pro' }], defaultSpaceId: PRO, projects: [], undated: 'today', today: '2026-10-05' as LocalDate };
const chr = (...codes: number[]): string => String.fromCharCode(...codes);

function run(row: string) {
  const parsed = parseImportFile(`titre;date;heure;espace;projet;note\n${row}`);
  if (!parsed.ok) throw new Error(parsed.error);
  return validateImportRows(parsed.table, context);
}

describe('Caractères de contrôle et marques bidirectionnelles (P-07, audit)', () => {
  it('catégorie Unicode Cf : trait d’union conditionnel, U+2060 à U+2064, U+180E, sélecteurs de variation, balises', () => {
    expect(sanitizeLine(`co${chr(0xad)}op`)).toBe('coop');
    expect(sanitizeLine(`a${chr(0x2060, 0x2061, 0x2062, 0x2063, 0x2064)}b`)).toBe('ab');
    expect(sanitizeLine(`a${chr(0x180e)}b${chr(0x2066, 0x206f)}c`)).toBe('abc');
    expect(sanitizeLine(`a${chr(0xfe00, 0xfe01, 0xfe0e)}b`)).toBe('ab');
    expect(sanitizeLine(`x${String.fromCodePoint(0xe0041, 0xe0001, 0xe007f, 0xe0100)}y`)).toBe('xy');
    expect(sanitizeNote(`n${chr(0xad)}ote${chr(0x2060)}`)).toBe('note');
    // Texte courant conservé : accents, ponctuation, chiffres arabes (U+0600 reste, signe visible).
    expect(sanitizeLine('Café – déjà 12 € « ok »')).toBe('Café – déjà 12 € « ok »');
    expect(sanitizeLine(`${chr(0x600)}١٢٣`)).toBe(`${chr(0x600)}١٢٣`);
  });

  it('émojis composés conservés (liaison U+200D entre pictogrammes, présentation U+FE0F), liaison isolée retirée', () => {
    const family = `${String.fromCodePoint(0x1f468)}${chr(0x200d)}${String.fromCodePoint(0x1f469)}${chr(0x200d)}${String.fromCodePoint(0x1f467)}`;
    expect(sanitizeLine(`Famille ${family}`)).toBe(`Famille ${family}`);
    const heart = `${chr(0x2764, 0xfe0f)}`;
    expect(sanitizeLine(`J'aime ${heart}`)).toBe(`J'aime ${heart}`);
    const heartFire = `${chr(0x2764, 0xfe0f, 0x200d)}${String.fromCodePoint(0x1f525)}`;
    expect(sanitizeNote(heartFire)).toBe(heartFire);
    expect(sanitizeLine(`a${chr(0x200d)}b`)).toBe('ab');
    expect(sanitizeLine(`${String.fromCodePoint(0x1f468)}${chr(0x200d)}b`)).toBe(String.fromCodePoint(0x1f468) + 'b');
    expect(sanitizeLine(`a${chr(0xfe0f)}`)).toBe('a');
  });

  it('titre, espace et projet : C0 et C1 retirés, la tabulation devient une espace, marques bidirectionnelles retirées', () => {
    expect(sanitizeLine(`A${chr(0)}B${chr(7)}C${chr(0x1b)}D${chr(0x7f)}E${chr(0x85)}F${chr(0x9f)}G`)).toBe('ABCDEFG');
    expect(sanitizeLine(`un${chr(9)}titre`)).toBe('un titre');
    expect(sanitizeLine(`${chr(0x202e)}gnirts${chr(0x202a)}${chr(0x202d)}${chr(0x2066)}${chr(0x2069)}`)).toBe('gnirts');
    expect(sanitizeLine('Réunion « équipe » 😀')).toBe('Réunion « équipe » 😀');
    expect(sanitizeLine(`a${chr(10)}b${chr(13)}c`)).toBe('abc');
  });

  it('espaces de largeur nulle, marques U+200E / U+200F / U+061C, séparateurs U+2028 / U+2029 et U+FEFF retirés (titre et note)', () => {
    const invisible = chr(0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0xfeff);
    expect(sanitizeLine(`Pa${invisible}ul`)).toBe('Paul');
    expect(sanitizeNote(`no${invisible}te\nsuite`)).toBe('note\nsuite');
    // Une marque d'ordre des octets en TÊTE de fichier est retirée avant l'analyse, sans toucher à l'en-tête.
    const parsed = parseImportFile(`${chr(0xfeff)}titre\nA`);
    expect(parsed.ok && parsed.table.columns.titre).toBe(0);
  });

  it('note : seuls \\n et \\t sont gardés ; CRLF et CR deviennent \\n', () => {
    expect(sanitizeNote(`l1${chr(13, 10)}l2${chr(13)}l3${chr(10)}l4${chr(9)}x${chr(0)}${chr(0x1b)}${chr(0x202e)}`)).toBe(`l1\nl2\nl3\nl4${chr(9)}x`);
  });

  it('appliqués à l’import : titre, espace, projet et note', () => {
    const { valid, rejected } = run(`${chr(0x202e)}Appeler${chr(0)} Paul${chr(9)};;;Pro${chr(0x202c)}${chr(7)};;ligne 1${chr(0x1b)}\nsuite`.replace('\nsuite', ''));
    expect(rejected).toEqual([]);
    expect(valid[0]?.title).toBe('Appeler Paul');
    expect(valid[0]?.spaceName).toBe('Pro');
    expect(valid[0]?.note).toBe('ligne 1');
  });

  it('un titre fait uniquement de caractères de contrôle est un titre vide', () => {
    expect(run(`${chr(0, 7, 0x202e)};;;;;`).rejected[0]?.reason).toEqual({ code: 'title-empty' });
  });

  it('la valeur recopiée dans un motif est nettoyée et tronquée à environ 60 caractères', () => {
    const long = 'x'.repeat(200);
    const { rejected } = run(`A;${long};;;;`);
    const reason = rejected[0]?.reason;
    expect(reason?.code).toBe('date-invalid');
    const value = reason && 'value' in reason ? reason.value : '';
    expect([...value]).toHaveLength(IMPORT_REASON_VALUE_MAX + 1);
    expect(value.endsWith('…')).toBe(true);
    expect(truncateValue('court')).toBe('court');
    expect(truncateValue(`a${chr(0x202e)}b`)).toBe('ab');
  });

  it('un espace inconnu très long est tronqué aussi', () => {
    const { rejected } = run(`A;;;${'é'.repeat(300)};;`);
    const reason = rejected[0]?.reason;
    expect(reason?.code).toBe('space-unknown');
    expect([...(reason && 'value' in reason ? reason.value : '')].length).toBeLessThanOrEqual(IMPORT_REASON_VALUE_MAX + 1);
  });
});

describe('Colonnes et noms (P-07, revue)', () => {
  it('plus de 256 colonnes : fichier refusé', () => {
    const header = ['titre', ...Array.from({ length: IMPORT_MAX_COLUMNS }, (_, i) => `c${String(i)}`)].join(';');
    expect(parseImportFile(`${header}\nA`)).toEqual({ ok: false, error: 'too-many-columns' });
    const ok = ['titre', ...Array.from({ length: IMPORT_MAX_COLUMNS - 1 }, (_, i) => `c${String(i)}`)].join(';');
    expect(parseImportFile(`${ok}\nA`).ok).toBe(true);
  });

  it('les en-têtes ignorés affichés sont nettoyés et tronqués', () => {
    const parsed = parseImportFile(`titre;${'z'.repeat(200)}${chr(0x202e)}\nA`);
    expect(parsed.ok && parsed.table.ignored[0]?.length).toBeLessThanOrEqual(IMPORT_REASON_VALUE_MAX + 1);
  });

  it('comparaison sans accents ni casse (diacritiques combinants retirés)', () => {
    expect(normalizeName('  PÉRSO  ')).toBe('perso');
    expect(normalizeName(`Pe${chr(0x301)}rso`)).toBe('perso');
  });

  it('noms de fichier du modèle et du rapport', () => {
    expect(importFileName('template')).toBe('circletasks-modele-import.csv');
    expect(importFileName('report')).toBe('circletasks-import-lignes-rejetees.csv');
  });
});
