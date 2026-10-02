import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { addDays } from '../../domain/localDate';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TodayScreen } from './TodayScreen';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000012');

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const CTRL_SHIFT_D = { key: 'D', code: 'KeyD', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, editable: false };

describe('duplication depuis Aujourd’hui et la fiche (T-12)', () => {
  let db: TestDb;
  let container: AppContainer;
  let today: ReturnType<typeof todayLocal>;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
    today = todayLocal(db.clock);
    const created = await createTaskUseCases(container).create({ title: 'Courses', spaceId: SPACE_PRO_ID, date: today });
    if (!created.ok) throw new Error('création impossible');
  });

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useAppStore.getState().setSpaces([]);
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  const renderScreen = () =>
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );
  const titles = async (date = today) => (await db.data.repos.tasks.listForDay(date, 'all')).map((task) => task.title);

  it('Ctrl+Maj+D ouvre le sélecteur présélectionné sur la date de l’original ; valider crée la copie, message Annuler, fiche non ouverte (critères 1, 3, 7, 9)', async () => {
    mockViewport(1440);
    renderScreen();
    fireEvent.focus(await screen.findByRole('checkbox', { name: 'Terminer : Courses' }));

    expect(container.shortcuts.handle(CTRL_SHIFT_D)).toBe('list.duplicate');
    const dialog = await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    expect(within(dialog).getByLabelText('Choisir une date de report')).toHaveValue(today);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dupliquer' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Courses' })).toHaveLength(2));
    expect(await titles()).toEqual(['Courses', 'Courses']);
    expect(screen.getByRole('status')).toHaveTextContent('« Courses » dupliquée');
    expect(screen.queryByRole('complementary', { name: 'Détail de la tâche' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Courses' })).toHaveLength(1));
    expect(await titles()).toEqual(['Courses']);
  });

  it('une autre date choisie : la copie n’est pas dans Aujourd’hui mais en base (critère 3)', async () => {
    mockViewport(1440);
    renderScreen();
    fireEvent.focus(await screen.findByRole('checkbox', { name: 'Terminer : Courses' }));
    container.shortcuts.handle(CTRL_SHIFT_D);
    const dialog = await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    const tomorrow = addDays(today, 1);
    fireEvent.change(within(dialog).getByLabelText('Choisir une date de report'), { target: { value: tomorrow } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dupliquer' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('dupliquée'));
    expect(await titles(tomorrow)).toEqual(['Courses']);
    expect(screen.getAllByRole('button', { name: 'Courses' })).toHaveLength(1);
  });

  it('Échap ne crée rien (critère 6) ; « Un jour » crée une copie sans date (critère 5)', async () => {
    mockViewport(1440);
    renderScreen();
    fireEvent.focus(await screen.findByRole('checkbox', { name: 'Terminer : Courses' }));
    container.shortcuts.handle(CTRL_SHIFT_D);
    await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(container.undo.getSnapshot().size).toBe(0);

    container.shortcuts.handle(CTRL_SHIFT_D);
    const dialog = await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Un jour' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dupliquer' }));
    await waitFor(() => expect(container.undo.getSnapshot().size).toBe(1));
    const someday = await db.data.repos.tasks.listSomeday('all');
    expect(someday.map((task) => [task.title, task.date])).toEqual([['Courses', null]]);
  });

  it('fiche détail : « Dupliquer » ouvre le même sélecteur, l’original reste sélectionné (critères 2, 9)', async () => {
    mockViewport(1440);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Courses' }));
    const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Dupliquer la tâche' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    expect(within(dialog).getByLabelText('Choisir une date de report')).toHaveValue(today);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dupliquer' }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Courses' })).toHaveLength(2));
    expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    expect(useNavigationStore.getState().detail).toMatchObject({ type: 'task' });
  });

  it('une tâche terminée peut être dupliquée : la copie est à faire (critère 8)', async () => {
    mockViewport(1440);
    renderScreen();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : Courses' }));
    const reopen = await screen.findByRole('checkbox', { name: 'Rouvrir : Courses' });
    fireEvent.focus(reopen);
    container.shortcuts.handle(CTRL_SHIFT_D);
    const dialog = await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dupliquer' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Terminer : Courses' })).toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Rouvrir : Courses' })).toBeInTheDocument();
  });

  it('iPhone : « Dupliquer » de la fiche ouvre le sélecteur (critère 2)', async () => {
    mockViewport(390);
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Courses' }));
    const sheet = await screen.findByRole('dialog', { name: 'Détail de la tâche' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Dupliquer la tâche' }));
    expect(await screen.findByRole('dialog', { name: 'Choisir la date de la copie' })).toBeInTheDocument();
  });

  it('échec d’écriture : message dédié, aucun rejet non géré', async () => {
    mockViewport(1440);
    renderScreen();
    fireEvent.focus(await screen.findByRole('checkbox', { name: 'Terminer : Courses' }));
    vi.spyOn(db.data, 'transaction').mockRejectedValueOnce(new Error('boom'));
    container.shortcuts.handle(CTRL_SHIFT_D);
    const dialog = await screen.findByRole('dialog', { name: 'Choisir la date de la copie' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dupliquer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de dupliquer cette tâche.');
  });
});
