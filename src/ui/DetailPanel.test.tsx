import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DetailPanel } from './DetailPanel';

describe('DetailPanel', () => {
  it('rend un panneau nommé (aside)', () => {
    render(
      <DetailPanel label="Envoyer la facture" onClose={() => undefined}>
        <p data-testid="content" />
      </DetailPanel>,
    );
    expect(screen.getByRole('complementary', { name: 'Envoyer la facture' })).toBeInTheDocument();
  });

  it('propose un bouton de fermeture', () => {
    const onClose = vi.fn();
    render(
      <DetailPanel label="Envoyer la facture" onClose={onClose}>
        <p data-testid="content" />
      </DetailPanel>,
    );
    screen.getByRole('button', { name: 'Fermer le détail' }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('appelle onClose sur Échap', () => {
    const onClose = vi.fn();
    render(
      <DetailPanel label="Envoyer la facture" onClose={onClose}>
        <p data-testid="content" />
      </DetailPanel>,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('déplace le focus dans le panneau au montage', () => {
    render(
      <DetailPanel label="Envoyer la facture" onClose={() => undefined}>
        <p data-testid="content" />
      </DetailPanel>,
    );
    expect(screen.getByRole('button', { name: 'Fermer le détail' })).toHaveFocus();
  });
});
