import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { createCarryOverUseCases } from '../tasks/carryOverUseCases';
import { TodayScreen } from './TodayScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000006');

describe('TodayScreen : badge « reportée » (T-06)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 1024px'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    // Midi UTC : même jour civil dans les fuseaux courants.
    db = await openTestDb(DEVICE, '2026-09-23T12:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ day: null, carryOverFailed: false, spaces: [] });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function seedLate(): Promise<void> {
    const useCases = createTaskUseCases(container);
    await useCases.create({ title: 'Mettre à jour le budget', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-09-22'), time: asLocalTime('09:00') });
    await useCases.create({ title: 'Tâche du jour', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-09-23') });
  }

  const renderToday = () =>
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );

  it('affiche « reportée · Pro » sur une tâche reportée, pas sur les autres (critère 3)', async () => {
    await seedLate();
    await createCarryOverUseCases(container).run();
    renderToday();
    const late = (await screen.findByRole('button', { name: 'Mettre à jour le budget' })).closest('.ct-list-row') as HTMLElement;
    expect(within(late).getByText('reportée')).toBeInTheDocument();
    expect(late).toHaveTextContent('09:00 · reportée · Pro');
    const normal = screen.getByRole('button', { name: 'Tâche du jour' }).closest('.ct-list-row') as HTMLElement;
    expect(within(normal).queryByText('reportée')).toBeNull();
  });

  it('terminer la tâche reportée efface le badge (critère 4)', async () => {
    await seedLate();
    await createCarryOverUseCases(container).run();
    renderToday();
    await screen.findByText('reportée');
    act(() => screen.getByRole('checkbox', { name: 'Terminer : Mettre à jour le budget' }).click());
    await waitFor(() => expect(screen.queryByText('reportée')).toBeNull());
  });

  it('passage de minuit : l’écran suit le nouveau jour publié par le rollover', async () => {
    await seedLate();
    renderToday();
    await screen.findByRole('button', { name: 'Tâche du jour' });
    expect(screen.queryByRole('button', { name: 'Mettre à jour le budget' })).toBeNull();
    db.clock.advance(24 * 3_600_000);
    await createCarryOverUseCases(container).run();
    act(() => useAppStore.getState().setDay(asLocalDate('2026-09-24')));
    await screen.findByRole('button', { name: 'Mettre à jour le budget' });
    expect(screen.getAllByText('reportée')).toHaveLength(2);
  });

  it('affiche un message si le report a échoué', () => {
    useAppStore.getState().setCarryOverFailed(true);
    renderToday();
    expect(screen.getByRole('alert')).toHaveTextContent('Impossible de reporter les tâches non faites.');
  });
});
