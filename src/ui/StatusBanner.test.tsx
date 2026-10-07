import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListSkeleton } from './ListSkeleton';
import { StatusBanner, StatusBannerRegion } from './StatusBanner';

describe('StatusBanner (A-09)', () => {
  it('affiche le message, sans bouton par défaut ni rôle propre (la région vivante est montée par l’appelant)', () => {
    render(<StatusBanner message="Hors ligne" />);
    expect(screen.getByText('Hors ligne')).toBeInTheDocument();
    expect(screen.queryByTestId('status-banner-region')).toBeNull();
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

describe('StatusBannerRegion (revue d’accessibilité, ordre 4)', () => {
  it('reste montée quand elle est vide, puis reçoit le bandeau dans le même élément', () => {
    const { rerender } = render(<StatusBannerRegion />);
    const region = screen.getByTestId('status-banner-region');
    expect(region).toBeEmptyDOMElement();
    rerender(
      <StatusBannerRegion>
        <StatusBanner message="Hors ligne" />
      </StatusBannerRegion>,
    );
    expect(screen.getByTestId('status-banner-region')).toBe(region);
    expect(region).toHaveTextContent('Hors ligne');
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
