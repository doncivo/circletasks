import { Search } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';

describe('Icon', () => {
  it('est décorative et masquée aux lecteurs d’écran par défaut', () => {
    const { container } = render(<Icon icon={Search} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).not.toHaveAttribute('role');
    expect(svg).not.toHaveAttribute('aria-label');
  });

  it('applique la taille, la couleur et l’épaisseur du trait des maquettes par défaut', () => {
    const { container } = render(<Icon icon={Search} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '24');
    expect(svg).toHaveAttribute('height', '24');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('stroke-width', '1.8');
  });

  it('accepte une taille, une couleur et une épaisseur personnalisées', () => {
    const { container } = render(<Icon icon={Search} size={30} color="#3F7FC4" strokeWidth={2.2} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveAttribute('height', '30');
    expect(svg).toHaveAttribute('stroke', '#3F7FC4');
    expect(svg).toHaveAttribute('stroke-width', '2.2');
  });

  it('devient porteuse de sens quand un libellé accessible est fourni', () => {
    render(<Icon icon={Search} label="Rechercher" />);
    const img = screen.getByRole('img', { name: 'Rechercher' });
    expect(img).not.toHaveAttribute('aria-hidden');
  });
});
