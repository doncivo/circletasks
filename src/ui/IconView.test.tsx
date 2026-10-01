import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IconView } from './IconView';

describe('IconView', () => {
  it('rend une icône Lucide du catalogue, décorative par défaut', () => {
    const { container } = render(<IconView icon={{ kind: 'lucide', name: 'file-text' }} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('rend un emoji tel quel', () => {
    render(<IconView icon={{ kind: 'emoji', value: '📄' }} />);
    expect(screen.getByText('📄')).toBeInTheDocument();
  });

  it('devient porteuse de sens avec un libellé, icône comme emoji', () => {
    render(<IconView icon={{ kind: 'lucide', name: 'phone' }} label="Téléphone" />);
    expect(screen.getByRole('img', { name: 'Téléphone' })).toBeInTheDocument();
    render(<IconView icon={{ kind: 'emoji', value: '📞' }} label="Téléphone emoji" />);
    expect(screen.getByRole('img', { name: 'Téléphone emoji' })).toBeInTheDocument();
  });

  it('ne rend rien pour un nom Lucide absent du catalogue', () => {
    const { container } = render(<IconView icon={{ kind: 'lucide', name: 'inconnu-total' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('applique la taille et la couleur demandées', () => {
    const { container } = render(<IconView icon={{ kind: 'lucide', name: 'target' }} size={30} color="#3F7FC4" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '30');
    expect(svg).toHaveAttribute('stroke', '#3F7FC4');
  });
});
