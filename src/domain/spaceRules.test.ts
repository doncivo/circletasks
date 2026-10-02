import { describe, expect, it } from 'vitest';
import { asEntityId, type SpaceId } from './types';
import type { Space } from './model';
import {
  PROJECT_PALETTE,
  SPACE_NAME_MAX_LENGTH,
  SPACE_PALETTES,
  contrastRatio,
  isSpaceColorAllowed,
  mixWithWhite,
  spacePalette,
  spaceSlot,
  validateSpaceName,
} from './spaceRules';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000002');
const spaces: Pick<Space, 'id' | 'sortOrder'>[] = [
  { id: PRO, sortOrder: 1 },
  { id: PERSO, sortOrder: 2 },
];

describe('validateSpaceName (ES-01 critère 4)', () => {
  it('accepte un nom nettoyé de 1 à 30 caractères', () => {
    expect(validateSpaceName('  Conseil  ', ['Perso'])).toEqual({ ok: true, value: 'Conseil' });
    expect(validateSpaceName('a'.repeat(SPACE_NAME_MAX_LENGTH), [])).toMatchObject({ ok: true });
  });
  it('refuse vide, trop long et identique à l’autre espace sans tenir compte de la casse', () => {
    expect(validateSpaceName('   ', [])).toEqual({ ok: false, error: 'empty-name' });
    expect(validateSpaceName('a'.repeat(SPACE_NAME_MAX_LENGTH + 1), [])).toEqual({ ok: false, error: 'name-too-long' });
    expect(validateSpaceName('PERSO', ['Perso'])).toEqual({ ok: false, error: 'name-taken' });
    expect(validateSpaceName('élan', ['Élan'])).toEqual({ ok: false, error: 'name-taken' });
  });
});

describe('palettes (ES-01 critères 5 et 7)', () => {
  it('Pro et Perso ont chacun quatre couleurs, la première étant la couleur validée', () => {
    expect(SPACE_PALETTES.map((p) => p.length)).toEqual([4, 4]);
    expect(SPACE_PALETTES[0]?.[0]?.hex).toBe('#2f6b7a');
    expect(SPACE_PALETTES[1]?.[0]?.hex).toBe('#b5483b');
  });
  it('la palette suit le rang de l’espace ; une couleur hors palette est refusée', () => {
    expect(spaceSlot(spaces, PERSO)).toBe(1);
    expect(spacePalette(spaces, PRO).map((c) => c.id)).toEqual(['teal', 'violet', 'green', 'blue']);
    expect(isSpaceColorAllowed(spaces, PERSO, '#b04a7a')).toBe(true);
    expect(isSpaceColorAllowed(spaces, PERSO, '#2f6b7a')).toBe(false);
    expect(spaceSlot(spaces, 'inconnu')).toBe(0);
  });
  it('toutes les couleurs sont AA (≥ 4,5) sur fond clair et, éclaircies de 55 %, sur fond sombre', () => {
    for (const { hex } of PROJECT_PALETTE) {
      expect(contrastRatio(hex, '#ffffff'), hex).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(mixWithWhite(hex, 0.55), '#1c1630'), hex).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(mixWithWhite(hex, 0.55), '#2a2242'), hex).toBeGreaterThanOrEqual(4.5);
    }
  });
});
