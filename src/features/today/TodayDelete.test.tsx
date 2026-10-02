import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
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

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000011');

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const key = (k: string, extra: Partial<{ ctrlKey: boolean; code: string }> = {}) => ({
  key: k,
  code: extra.code ?? k,
  ctrlKey: extra.ctrlKey ?? false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  editable: false,
});

describe('suppression depuis Aujourd’hui et la fiche détail (T-08)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
    const created = await createTaskUseCases(container).create({ title: 'Courses', spaceId: SPACE_PRO_ID, date: todayLocal(db.clock) });
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

  async function openDetail(): Promise<HTMLElement> {
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Courses' }));
    return screen.findByRole('complementary', { name: 'Détail de la tâche' });
  }

  async function rowsOf(title: string): Promise<number> {
    return (await db.data.repos.tasks.listForDay(todayLocal(db.clock), 'all')).filter((task) => task.title === title).length;
  }

  it('PC : « Supprimer » ouvre la confirmation, focus sur « Annuler », rien n’est supprimé avant (critère 1)', async () => {
    mockViewport(1440);
    const panel = await openDetail();
    fireEvent.click(within(panel).getByRole('button', { name: 'Supprimer' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Supprimer « Courses » ?' });
    expect(within(dialog).getByRole('button', { name: 'Annuler' })).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
    expect(await rowsOf('Courses')).toBe(1);
  });

  it('PC : confirmer supprime, ferme la fiche, retire la ligne et affiche le message Annuler (critères 2, 3)', async () => {
    mockViewport(1440);
    const panel = await openDetail();
    fireEvent.click(within(panel).getByRole('button', { name: 'Supprimer' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Détail de la tâche' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Courses' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('« Courses » supprimée');
    expect(await rowsOf('Courses')).toBe(0);
    expect(useNavigationStore.getState().detail).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByRole('button', { name: 'Courses' })).toBeInTheDocument();
    expect(await rowsOf('Courses')).toBe(1);
  });

  it('Annuler la confirmation ou Échap ne supprime rien (critère 4)', async () => {
    mockViewport(1440);
    const panel = await openDetail();
    fireEvent.click(within(panel).getByRole('button', { name: 'Supprimer' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Supprimer' }));
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument(); // Échap n’a fermé que la confirmation
    expect(await rowsOf('Courses')).toBe(1);
    expect(container.undo.getSnapshot().size).toBe(0);
  });

  it('iPhone : le bouton s’intitule « Supprimer la tâche » (critère 1)', async () => {
    mockViewport(390);
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Courses' }));
    const sheet = await screen.findByRole('dialog', { name: 'Détail de la tâche' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Supprimer la tâche' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Détail de la tâche' })).not.toBeInTheDocument());
    expect(await rowsOf('Courses')).toBe(0);
  });

  it('Suppr sur la ligne sélectionnée : confirmation, puis Ctrl+Z restaure (critères 1, 3)', async () => {
    mockViewport(1440);
    render(
      <AppContainerProvider container={container}>
        <TodayScreen />
        <UndoToast />
      </AppContainerProvider>,
    );
    fireEvent.focus(await screen.findByRole('button', { name: 'Courses' }));
    await waitFor(() => expect(container.shortcuts.activeIds()).toContain('list.delete'));

    container.shortcuts.handle(key('Delete'));
    const dialog = await screen.findByRole('alertdialog', { name: 'Supprimer « Courses » ?' });
    expect(await rowsOf('Courses')).toBe(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Courses' })).not.toBeInTheDocument());

    container.shortcuts.handle(key('z', { ctrlKey: true, code: 'KeyZ' }));
    expect(await screen.findByRole('button', { name: 'Courses' })).toBeInTheDocument();
  });

  it('échec d’écriture : message d’erreur, tâche conservée, aucun rejet non géré (erreurs gérées)', async () => {
    mockViewport(1440);
    const panel = await openDetail();
    vi.spyOn(container.data, 'transaction').mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Supprimer' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }));

    expect(await within(panel).findByRole('alert')).toHaveTextContent('Impossible de supprimer cette tâche.');
    expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    expect(await rowsOf('Courses')).toBe(1);
  });
});
