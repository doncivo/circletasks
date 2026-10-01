import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListRow } from './ListRow';

const INVOICE = 'Envoyer la facture';
const SUBTITLE = '09:00 · Pro';
const WATER = "Boire de l'eau";
const BED = 'Faire mon lit';
const NOTARY = 'Appeler le notaire';

describe('ListRow', () => {
  it('affiche le titre et la sous-ligne', () => {
    render(<ListRow title={INVOICE} subtitle={SUBTITLE} />);
    expect(screen.getByText(INVOICE)).toBeInTheDocument();
    expect(screen.getByText(SUBTITLE)).toBeInTheDocument();
  });

  it('rend le titre interactif et ouvre le détail au clic', () => {
    const onActivate = vi.fn();
    render(<ListRow title={INVOICE} onActivate={onActivate} />);
    screen.getByRole('button', { name: INVOICE }).click();
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('n’est pas interactif sans onActivate', () => {
    render(<ListRow title={WATER} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('marque un élément terminé (data-done)', () => {
    render(<ListRow title={BED} done />);
    expect(screen.getByText(BED)).toHaveAttribute('data-done', 'true');
  });

  it('place l’élément de tête et l’icône de fin autour du corps', () => {
    render(<ListRow title={NOTARY} leading={<span data-testid="leading" />} icon={<span data-testid="icon" />} />);
    expect(screen.getByTestId('leading')).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});
