import { describe, expect, it } from 'vitest';
import { ICON_CATALOG, resolveIconComponent } from './iconCatalog';

describe('iconCatalog', () => {
  it('résout un nom connu vers un composant', () => {
    expect(resolveIconComponent('file-text')).toBe(ICON_CATALOG['file-text']);
  });

  it('renvoie null pour un nom inconnu', () => {
    expect(resolveIconComponent('inconnu-total')).toBeNull();
  });

  it('n’expose que des noms kebab-case', () => {
    for (const name of Object.keys(ICON_CATALOG)) {
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
