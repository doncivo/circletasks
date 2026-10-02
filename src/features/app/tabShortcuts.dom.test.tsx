import { describe, expect, it } from 'vitest';
import { isModalOpen } from './tabShortcuts';

describe('isModalOpen (A-04 critère 5)', () => {
  it('détecte une feuille modale et ignore un panneau non modal', () => {
    const root = document.createElement('div');
    root.innerHTML = '<aside aria-label="Détail"></aside>';
    expect(isModalOpen(root)).toBe(false);
    root.innerHTML = '<section role="dialog" aria-modal="true"></section>';
    expect(isModalOpen(root)).toBe(true);
  });

  it('lit le document par défaut', () => {
    expect(isModalOpen()).toBe(false);
  });
});
