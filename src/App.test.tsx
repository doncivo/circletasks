import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { useAppStore } from './features/app/appStore';
import { bootstrapApp } from './features/app/bootstrap';
import { INITIAL_NAVIGATION, useNavigationStore } from './features/app/navigation';
import { t } from './i18n';

// Seul le premier test a besoin de la vraie base (instanciation Wasm à froid, ~1 s,
// juste sous le délai par défaut de `findBy*`). Les autres rendent `App` sans
// attendre le démarrage : on neutralise `bootstrapApp` pour ne pas laisser une base
// Wasm s'ouvrir en tâche de fond pendant (et après) ces tests.
vi.mock('./features/app/bootstrap', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { bootstrapApp: typeof bootstrapApp }>();
  return { ...actual, bootstrapApp: vi.fn(actual.bootstrapApp) };
});

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('App (coquille, T-01)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ dbStatus: 'idle', dbErrorDetail: null, spaceFilter: 'all' });
    useNavigationStore.setState(INITIAL_NAVIGATION);
  });

  it('démarre la base réelle et affiche l’écran Aujourd’hui sur l’onglet Tâches', async () => {
    mockViewport(1440);
    render(<App />);
    expect(await screen.findByText(t('tasks.todayBadge'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(useAppStore.getState().dbStatus).toBe('ready');
    const tasksTab = screen.getByRole('button', { name: t('nav.tabs.tasks') });
    expect(tasksTab).toHaveAttribute('aria-current', 'page');
  });

  it('choisit la mise en page PC à partir de 1024 px', () => {
    vi.mocked(bootstrapApp).mockResolvedValueOnce(undefined);
    mockViewport(1440);
    const { container } = render(<App />);
    expect(container.firstElementChild).toHaveAttribute('data-layout', 'pc');
  });

  it('choisit la mise en page mobile en dessous de 1024 px', () => {
    vi.mocked(bootstrapApp).mockResolvedValueOnce(undefined);
    mockViewport(440);
    const { container } = render(<App />);
    expect(container.firstElementChild).toHaveAttribute('data-layout', 'mobile');
  });

  it('signale une erreur d’ouverture de base', () => {
    mockViewport(440);
    useAppStore.setState({ dbStatus: 'error' });
    render(<App />);
    expect(screen.getByRole('alert')).toHaveTextContent(t('app.dbError'));
  });
});
