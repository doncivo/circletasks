import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from './createTaskUseCases';
import { TrashScreen } from './TrashScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000012');
const DAY_MS = 86_400_000;

describe('TrashScreen (T-08)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.getState().setSpaceFilter('all');
    useAppStore.getState().setSpaces([]);
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function trashed(title: string, spaceId = SPACE_PRO_ID): Promise<TaskId> {
    const useCases = createTaskUseCases(container);
    const created = await useCases.create({ title, spaceId, date: todayLocal(db.clock) });
    if (!created.ok) throw new Error('création impossible');
    await useCases.remove([created.value.id]);
    return created.value.id;
  }

  const renderScreen = () =>
    render(
      <AppContainerProvider container={container}>
        <TrashScreen />
      </AppContainerProvider>,
    );

  it('liste les tâches supprimées, la plus récente d’abord, avec la date de suppression (critère 5)', async () => {
    await trashed('Ancienne');
    db.clock.advance(DAY_MS);
    await trashed('Récente');
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Corbeille' })).toBeInTheDocument();
    const titles = (await screen.findAllByRole('listitem')).map((li) => li.textContent ?? '');
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain('Récente');
    expect(titles[0]).toContain('supprimée le sam. 3 oct.');
    expect(titles[1]).toContain('Ancienne');
    expect(titles[1]).toContain('supprimée le ven. 2 oct.');
  });

  it('n’affiche pas une tâche supprimée depuis plus de 30 jours (critère 7)', async () => {
    await trashed('Vieille');
    db.clock.advance(31 * DAY_MS);
    renderScreen();
    expect(await screen.findByText('La corbeille est vide')).toBeInTheDocument();
    expect(screen.queryByText('Vieille')).not.toBeInTheDocument();
  });

  it('Restaurer : la ligne disparaît, la tâche revient à sa date dans son espace (critère 6)', async () => {
    const id = await trashed('Courses', SPACE_PERSO_ID);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurer : Courses' }));

    await waitFor(() => expect(screen.queryByText('Courses')).not.toBeInTheDocument());
    expect(screen.getByText('La corbeille est vide')).toBeInTheDocument();
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: todayLocal(db.clock), spaceId: SPACE_PERSO_ID, deletedAt: null });
    expect(container.taskEntities.get(id)?.title).toBe('Courses');
  });

  it('le filtre d’espace restreint la liste', async () => {
    await trashed('Pro 1', SPACE_PRO_ID);
    await trashed('Perso 1', SPACE_PERSO_ID);
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderScreen();
    expect(await screen.findByText('Perso 1')).toBeInTheDocument();
    expect(screen.queryByText('Pro 1')).not.toBeInTheDocument();
  });

  it('échec de chargement ou de restauration : message d’alerte, sans rejet non géré', async () => {
    await trashed('Courses');
    vi.spyOn(container.data.repos.tasks, 'listTrash').mockRejectedValueOnce(new Error('boom'));
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger la corbeille.');
    cleanup();

    vi.spyOn(container.data, 'transaction').mockRejectedValueOnce(new Error('boom'));
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Restaurer : Courses' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de restaurer cette tâche.');
    expect(within(screen.getByRole('list')).getByText('Courses')).toBeInTheDocument();
  });

  it('Retour renvoie vers Réglages', async () => {
    useNavigationStore.getState().navigate({ tab: 'settings', screen: 'trash' });
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Retour' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'home' });
  });
});
