import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IconPicker } from './IconPicker';

describe('IconPicker (T-03)', () => {
  it('expose un groupe nommé et affiche une pastille par icône du catalogue', () => {
    render(<IconPicker value={null} onChange={() => undefined} />);
    expect(screen.getByRole('group', { name: 'Choisir une icône' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Icône téléphone' })).toBeInTheDocument();
  });

  it('marque l’icône choisie (aria-pressed et libellé « choisie »), critère 1', () => {
    render(<IconPicker value={{ kind: 'lucide', name: 'phone' }} onChange={() => undefined} />);
    const chosen = screen.getByRole('button', { name: 'Icône téléphone, choisie' });
    expect(chosen).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Icône document' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('sélectionne l’icône touchée', () => {
    const onChange = vi.fn();
    render(<IconPicker value={null} onChange={onChange} />);
    screen.getByRole('button', { name: 'Icône téléphone' }).click();
    expect(onChange).toHaveBeenCalledWith({ kind: 'lucide', name: 'phone' });
  });

  it('un second toucher désélectionne l’icône choisie (critère 1)', () => {
    const onChange = vi.fn();
    render(<IconPicker value={{ kind: 'lucide', name: 'phone' }} onChange={onChange} />);
    screen.getByRole('button', { name: 'Icône téléphone, choisie' }).click();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('ignore une icône emoji passée en valeur (un seul champ icon, critère 2)', () => {
    render(<IconPicker value={{ kind: 'emoji', value: '📞' }} onChange={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Icône téléphone' })).toHaveAttribute('aria-pressed', 'false');
  });
});
