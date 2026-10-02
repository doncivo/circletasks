import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { useQuickAddStore } from '../app/quickAdd';
import { TodayScreen } from './TodayScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d5');

describe('Ajout rapide de la zone de notification dans Aujourd’hui (D-01, critère 5)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 1024px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.getState().setSpaces([]);
    useNavigationStore.setState(INITIAL_NAVIGATION);
    useQuickAddStore.setState({ pending: false });
    await db.close();
  });

  const renderToday = () =>
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
      </AppContainerProvider>,
    );

  it('écran déjà affiché : le champ « Nouvelle tâche » prend le focus', async () => {
    renderToday();
    const field = screen.getByLabelText('Nouvelle tâche');
    expect(field).not.toHaveFocus();
    act(() => useQuickAddStore.getState().request());
    await waitFor(() => expect(field).toHaveFocus());
    expect(useQuickAddStore.getState().pending).toBe(false);
  });

  it('demande faite avant l’affichage d’Aujourd’hui : le focus est donné au montage, une seule fois', async () => {
    useQuickAddStore.setState({ pending: true });
    const first = renderToday();
    await waitFor(() => expect(screen.getByLabelText('Nouvelle tâche')).toHaveFocus());
    first.unmount();
    renderToday();
    expect(screen.getByLabelText('Nouvelle tâche')).not.toHaveFocus();
  });
});
