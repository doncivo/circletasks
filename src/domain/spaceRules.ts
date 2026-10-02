import type { Space } from './model';
import { asHexColor, type HexColor, type Result } from './types';

/** Longueur maximale du nom d'un espace (ES-01 critère 4) : contrainte technique proposée par la fiche. */
export const SPACE_NAME_MAX_LENGTH = 30;

export type SpaceNameError = 'empty-name' | 'name-too-long' | 'name-taken';

/** Comparaison de noms sans tenir compte de la casse ni des accents de forme (« Pro » = « pro »). */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('fr') === b.trim().toLocaleLowerCase('fr');
}

/**
 * Valide le nom d'un espace (ES-01 critère 4) : 1 à 30 caractères après nettoyage, différent (sans tenir compte de la casse) de celui
 * de l'autre espace. `otherNames` = noms des AUTRES espaces. Le nom accepté est rendu nettoyé (espaces de début et de fin retirés).
 */
export function validateSpaceName(raw: string, otherNames: readonly string[]): Result<string, SpaceNameError> {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: 'empty-name' };
  if (name.length > SPACE_NAME_MAX_LENGTH) return { ok: false, error: 'name-too-long' };
  if (otherNames.some((other) => sameName(other, name))) return { ok: false, error: 'name-taken' };
  return { ok: true, value: name };
}

/** Choix de couleur : identifiant stable (libellé i18n `spaces.colors.<id>`) et valeur. */
export interface ColorChoice {
  readonly id: string;
  readonly hex: HexColor;
}

const choice = (id: string, hex: string): ColorChoice => ({ id, hex: asHexColor(hex) });

/**
 * Palettes des espaces (ES-01, Bienvenue.html) : quatre couleurs par espace, chacune au contraste AA (≥ 4,5) sur fond clair
 * comme, éclaircie par `--ct-space-white`, sur fond sombre (testé dans `spaceRules.test.ts`). Le premier espace (Pro) a la première
 * palette, le second (Perso) la seconde ; la première couleur de chaque palette est la couleur par défaut.
 */
export const SPACE_PALETTES: readonly (readonly ColorChoice[])[] = [
  [choice('teal', '#2f6b7a'), choice('violet', '#5b43a8'), choice('green', '#3e7c5a'), choice('blue', '#1f6698')],
  [choice('brick', '#b5483b'), choice('ochre', '#8a6d1f'), choice('rose', '#b04a7a'), choice('plum', '#6a3d6e')],
];

/** Rang d'un espace dans l'ordre d'affichage (0 = Pro, 1 = Perso) : choisit sa palette. */
export function spaceSlot(spaces: readonly Pick<Space, 'id' | 'sortOrder'>[], spaceId: string): number {
  const sorted = [...spaces].sort((a, b) => a.sortOrder - b.sortOrder);
  const index = sorted.findIndex((space) => space.id === spaceId);
  return Math.min(Math.max(index, 0), SPACE_PALETTES.length - 1);
}

export function spacePalette(spaces: readonly Pick<Space, 'id' | 'sortOrder'>[], spaceId: string): readonly ColorChoice[] {
  return SPACE_PALETTES[spaceSlot(spaces, spaceId)] ?? [];
}

/** Une couleur est-elle proposée par la palette de l'espace ? (un enregistrement hors palette est refusé) */
export function isSpaceColorAllowed(spaces: readonly Pick<Space, 'id' | 'sortOrder'>[], spaceId: string, color: string): boolean {
  return spacePalette(spaces, spaceId).some((c) => c.hex === color);
}

/** Palette des projets (ES-04 critère 3) : couleurs fixes, AA, choisies parmi celles des deux palettes d'espaces. */
export const PROJECT_PALETTE: readonly ColorChoice[] = SPACE_PALETTES.flat();

/** Luminance relative WCAG d'une couleur '#rrggbb'. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapport de contraste WCAG entre deux couleurs '#rrggbb'. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Couleur mélangée à du blanc (part `white`, 0 à 1) : équivalent de `spaceTextColor` en thème sombre. */
export function mixWithWhite(hex: string, white: number): string {
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - white) + 255 * white).toString(16).padStart(2, '0')).join('')}`;
}

/** Nombre de projets actifs (non archivés, non supprimés) d'un espace : ligne « Espaces et projets » de Réglages (ES-01 critère 2). */
export function activeProjectCount(projects: readonly { readonly spaceId: string; readonly archived: boolean; readonly deletedAt: string | null }[], spaceId: string): number {
  return projects.filter((project) => project.spaceId === spaceId && !project.archived && project.deletedAt === null).length;
}
