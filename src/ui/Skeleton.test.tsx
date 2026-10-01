import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('annonce le chargement via un statut nommé', () => {
    render(<Skeleton />);
    expect(screen.getByRole('status', { name: 'Chargement…' })).toBeInTheDocument();
  });

  it('rend le nombre de lignes demandé', () => {
    const { container } = render(<Skeleton count={3} />);
    expect(container.querySelectorAll('.ct-skeleton')).toHaveLength(3);
  });

  it('applique la largeur, la hauteur et le rayon demandés', () => {
    const { container } = render(<Skeleton width="60%" height="20px" radius="round" />);
    const bar = container.querySelector('.ct-skeleton') as HTMLElement;
    expect(bar.style.width).toBe('60%');
    expect(bar.style.height).toBe('20px');
    expect(bar.style.borderRadius).toBe('var(--ct-radius-round)');
  });
});
