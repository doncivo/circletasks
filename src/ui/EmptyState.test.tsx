import { fireEvent, render, screen } from '@testing-library/react';
import { BookOpen, Sunrise, ShoppingCart } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from './EmptyState';

const TITLE = 'Rien en attente.';
const TEXT = 'Explication';
const LABEL = 'Ajouter';
const SCREEN = 'week';

describe('EmptyState (P-06)', () => {
  it('rend le titre en niveau 2, le texte et une action utilisable', async () => {
    const onClick = vi.fn();
    render(<EmptyState title={TITLE} text={TEXT} action={{ label: LABEL, onClick }} />);
    expect(await screen.findByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument();
    expect(screen.getByText(TEXT)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('variantes : trois pastilles, une pastille, aucune ; icônes décoratives', () => {
    const { container, rerender } = render(<EmptyState title={TITLE} icons={[{ icon: BookOpen }, { icon: Sunrise }, { icon: ShoppingCart }]} />);
    expect(container.querySelector('.ct-empty')?.getAttribute('data-variant')).toBe('three');
    expect(container.querySelectorAll('.ct-empty__pill')).toHaveLength(3);
    expect(container.querySelector('.ct-empty__icons')?.getAttribute('aria-hidden')).toBe('true');
    rerender(<EmptyState title={TITLE} icons={[{ icon: BookOpen }]} />);
    expect(container.querySelector('.ct-empty')?.getAttribute('data-variant')).toBe('one');
    rerender(<EmptyState title={TITLE} />);
    expect(container.querySelector('.ct-empty')?.getAttribute('data-variant')).toBe('none');
    expect(container.querySelector('.ct-empty__pill')).toBeNull();
  });

  it('annonce son apparition poliment et expose l’identifiant d’écran', async () => {
    const { container } = render(<EmptyState title={TITLE} screen={SCREEN} />);
    const root = container.querySelector('.ct-empty');
    const live = root?.querySelector('[aria-live]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live).toHaveTextContent(/^$/); // région présente et vide au montage
    expect(await screen.findByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument();
    expect(live).toContainElement(screen.getByRole('heading', { level: 2 }));
    expect(root?.getAttribute('data-empty-screen')).toBe(SCREEN);
  });
});
