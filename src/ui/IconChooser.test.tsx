import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IconChooser } from './IconChooser';

describe('IconChooser (T-03)', () => {
  it('démarre en mode Icône par défaut et bascule en Emoji au clic (sémantique radio)', () => {
    render(<IconChooser value={null} onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'Icône' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Emoji' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: 'Icône téléphone' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Emoji' }));
    expect(screen.getByRole('radio', { name: 'Emoji' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Emoji téléphone' })).toBeInTheDocument();
  });

  it('démarre en mode Emoji quand la valeur initiale est un emoji', () => {
    render(<IconChooser value={{ kind: 'emoji', value: '📞' }} onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: 'Emoji' })).toHaveAttribute('aria-checked', 'true');
  });

  it('les flèches gauche/droite basculent le mode (WAI-ARIA Radio Group)', () => {
    render(<IconChooser value={null} onChange={() => undefined} />);
    const group = screen.getByRole('radiogroup', { name: 'Icône' });
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'Emoji' })).toHaveAttribute('aria-checked', 'true');
  });

  it('transmet la sélection choisie à onChange', () => {
    const onChange = vi.fn();
    render(<IconChooser value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Icône téléphone' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'lucide', name: 'phone' });
  });
});
