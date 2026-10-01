import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useAppStore } from './features/app/appStore';

vi.mock('./features/app/bootstrap', () => ({
  bootstrapDatabase: vi.fn(async () => {
    useAppStore.getState().setDbStatus('ready');
    return undefined;
  }),
}));

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('App (coquille)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null });
  });

  it('affiche le titre traduit et démarre la base', async () => {
    mockViewport(1440);
    render(<App />);
    expect(screen.getByRole('heading', { level: 1, name: 'CircleTasks' })).toBeInTheDocument();
    expect(await screen.findByRole('heading')).toBeVisible();
    expect(useAppStore.getState().dbStatus).toBe('ready');
  });

  it('choisit la mise en page PC à partir de 1024 px', () => {
    mockViewport(1440);
    const { container } = render(<App />);
    expect(container.firstElementChild).toHaveAttribute('data-layout', 'pc');
  });

  it('choisit la mise en page mobile en dessous de 1024 px', () => {
    mockViewport(440);
    const { container } = render(<App />);
    expect(container.firstElementChild).toHaveAttribute('data-layout', 'mobile');
  });

  it('signale une erreur d’ouverture de base', () => {
    mockViewport(440);
    useAppStore.setState({ dbStatus: 'error' });
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent('Impossible d’ouvrir la base de données.');
  });
});
