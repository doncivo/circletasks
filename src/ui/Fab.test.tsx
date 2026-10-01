import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Fab } from './Fab';

describe('Fab', () => {
  it('porte le libellé accessible par défaut « Ajouter »', () => {
    render(<Fab onClick={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Ajouter' })).toBeInTheDocument();
  });

  it('accepte un libellé personnalisé', () => {
    render(<Fab onClick={() => undefined} label="Nouvelle tâche" />);
    expect(screen.getByRole('button', { name: 'Nouvelle tâche' })).toBeInTheDocument();
  });

  it('déclenche onClick', () => {
    const onClick = vi.fn();
    render(<Fab onClick={onClick} />);
    screen.getByRole('button').click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('respecte la zone tactile minimale (≥ 44 px)', () => {
    render(<Fab onClick={() => undefined} />);
    const button = screen.getByRole('button');
    const width = Number(button.style.width.replace('px', ''));
    expect(width).toBeGreaterThanOrEqual(44);
  });
});
