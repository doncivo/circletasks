import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../domain/model/icon';
import { ICON_CATALOG, ICON_CATALOG_ENTRIES, resolveIconColor, resolveIconComponent, resolveIconLabelKey } from './iconCatalog';

describe('iconCatalog', () => {
  it('résout un nom connu vers un composant', () => {
    expect(resolveIconComponent('file-text')).toBe(ICON_CATALOG['file-text']);
  });

  it('renvoie null pour un nom inconnu', () => {
    expect(resolveIconComponent('inconnu-total')).toBeNull();
    expect(resolveIconColor('inconnu-total')).toBeNull();
    expect(resolveIconLabelKey('inconnu-total')).toBeNull();
  });

  it('n’expose que des noms kebab-case', () => {
    for (const name of Object.keys(ICON_CATALOG)) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('fournit une entrée (composant, couleur, libellé) pour chaque nom du catalogue domaine (T-03)', () => {
    expect(Object.keys(ICON_CATALOG_ENTRIES).sort()).toEqual([...ICON_NAMES].sort());
    for (const name of ICON_NAMES) {
      const entry = ICON_CATALOG_ENTRIES[name];
      expect(entry.component).toBeTypeOf('object');
      // Couleur toujours un jeton CSS (jamais une couleur en dur, CLAUDE.md).
      expect(entry.color).toMatch(/^var\(--ct-color-icon-[a-z]+\)$/);
      expect(entry.labelKey).toMatch(/^icons\./);
    }
  });
});
