import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Kbd } from './Kbd';

describe('Kbd', () => {
  it('localise les modificateurs en français (Maj)', () => {
    render(<Kbd keys="Ctrl+Shift+D" />);
    expect(screen.getByText('Ctrl+Maj+D')).toBeInTheDocument();
  });

  it('accepte un séparateur personnalisé, comme les maquettes (espace)', () => {
    render(<Kbd keys="Ctrl+N" separator=" " />);
    expect(screen.getByText('Ctrl N')).toBeInTheDocument();
  });

  it('traduit les touches nommées (Échap, flèches)', () => {
    render(<Kbd keys="Escape" />);
    expect(screen.getByText('Échap')).toBeInTheDocument();
  });

  it('laisse une touche simple inconnue telle quelle', () => {
    render(<Kbd keys="Alt+1" />);
    expect(screen.getByText('Alt+1')).toBeInTheDocument();
  });
});
