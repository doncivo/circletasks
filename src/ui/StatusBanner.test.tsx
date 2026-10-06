import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListSkeleton } from './ListSkeleton';
import { StatusBanner } from './StatusBanner';

describe('StatusBanner (A-09)', () => {
  it('est un statut annoncé poliment, sans bouton par défaut', () => {
    render(<StatusBanner message="Hors ligne" />);
    expect(screen.getByRole('status')).toHaveTextContent('Hors ligne');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('porte un bouton d’action facultatif (« Reconnecter »)', () => {
    const onAction = vi.fn();
    render(<StatusBanner message="Agenda Google déconnecté" actionLabel="Reconnecter" onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reconnecter' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('nom accessible du bouton distinct de son libellé court quand il est donné (revue A-09, point 11)', () => {
    render(<StatusBanner message="Échec" actionLabel="Voir" actionAriaLabel="Voir le problème de synchronisation" onAction={() => undefined} />);
    const button = screen.getByRole('button', { name: 'Voir le problème de synchronisation' });
    expect(button.textContent).toBe('Voir');
  });
});

describe('ListSkeleton (A-09 critère 2)', () => {
  it('est masqué aux lecteurs d’écran, sans texte « Chargement » bloquant', () => {
    const { container } = render(<ListSkeleton rows={3} />);
    const root = screen.getByTestId('list-skeleton');
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root).toHaveTextContent('');
    expect(container.querySelectorAll('.ct-list-skeleton__row')).toHaveLength(3);
  });
});
