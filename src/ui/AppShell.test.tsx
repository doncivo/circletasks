import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

const ORIGINAL_WIDTH = window.innerWidth;

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: ORIGINAL_WIDTH, configurable: true });
});

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

describe('AppShell', () => {
  it('affiche le panneau de détail sur PC (≥ 1024 px)', () => {
    setWidth(1280);
    render(
      <AppShell tabRail={<nav data-testid="tabrail" />} detail={<aside data-testid="detail" />}>
        <div data-testid="content" />
      </AppShell>,
    );
    expect(screen.getByTestId('detail')).toBeInTheDocument();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });

  it('masque le panneau de détail sur mobile', () => {
    setWidth(440);
    render(
      <AppShell tabRail={<nav data-testid="tabrail" />} detail={<aside data-testid="detail" />}>
        <div data-testid="content" />
      </AppShell>,
    );
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument();
  });

  it('rend l’emplacement du bouton d’ajout flottant si fourni', () => {
    render(
      <AppShell tabRail={<nav data-testid="tabrail" />} fab={<button type="button" data-testid="fab" />}>
        <div data-testid="content" />
      </AppShell>,
    );
    expect(screen.getByTestId('fab')).toBeInTheDocument();
  });

  it('rend toujours les onglets et le contenu', () => {
    render(
      <AppShell tabRail={<nav data-testid="tabrail" />}>
        <div data-testid="content" />
      </AppShell>,
    );
    expect(screen.getByTestId('tabrail')).toBeInTheDocument();
    expect(screen.getByTestId('content')).toBeInTheDocument();
  });
});
