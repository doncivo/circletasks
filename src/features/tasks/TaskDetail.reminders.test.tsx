import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { ReminderOffsetMin, Task } from '../../domain/model';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from './createTaskUseCases';
import { TaskDetail } from './TaskDetail';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000a09');
const NOW = new Date(2026, 8, 23, 8, 0).getTime();

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

/** N-02 : rappels sur la fiche détail (PC : clic sur la valeur ; iPhone : feuille « Modifier »). */
describe('Rappels de la fiche détail (N-02)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, NOW);
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ spaces: [], day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function open(time: string | null, offsets: ReminderOffsetMin[]): Promise<Task> {
    const created = await createTaskUseCases(container).create({
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-09-23'),
      ...(time ? { time: asLocalTime(time) } : {}),
      reminderOffsets: offsets,
    });
    if (!created.ok) throw new Error('création impossible');
    useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
    render(
      <AppContainerProvider container={container}>
        <TaskDetail />
      </AppContainerProvider>,
    );
    await screen.findByText('Rappels');
    return created.value;
  }

  const stored = async (task: Task) => (await db.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).map((r) => [r.offsetMin, r.fireAt]);

  describe('PC', () => {
    beforeEach(() => mockViewport(1440));

    it('une puce par rappel, de la plus proche à la plus lointaine (critère 3)', async () => {
      await open('09:00', [1440, 30, 0, 60, 5, 15]);
      const button = await screen.findByRole('button', { name: 'Modifier les rappels' });
      const chips = Array.from(button.querySelectorAll('.ct-task-detail__chip')).map((chip) => chip.textContent);
      expect(chips).toEqual(['À l’heure', '5 min avant', '15 min avant', '30 min avant', '1 h avant', '1 jour avant']);
    });

    it('cliquer sur la valeur édite : cocher / décocher ajoute et supprime les lignes (critère 4)', async () => {
      const task = await open('09:00', [0]);
      fireEvent.click(await screen.findByRole('button', { name: 'Modifier les rappels' }));
      const group = screen.getByRole('group', { name: 'Rappels' });
      fireEvent.click(within(group).getByRole('checkbox', { name: '30 min' }));
      await waitFor(async () => expect(await stored(task)).toEqual([[30, '2026-09-23T08:30'], [0, '2026-09-23T09:00']]));
      fireEvent.click(within(group).getByRole('button', { name: 'Plus…' }));
      expect(within(group).getAllByRole('checkbox')).toHaveLength(6);
      fireEvent.click(within(group).getByRole('checkbox', { name: '1 jour' }));
      await waitFor(async () => expect((await stored(task)).map((row) => row[0])).toEqual([0, 30, 1440].sort((a, b) => (a === 1440 ? -1 : b === 1440 ? 1 : b - a))));
      fireEvent.click(within(group).getByRole('checkbox', { name: 'À l’heure' }));
      await waitFor(async () => expect((await stored(task)).map((row) => row[0])).not.toContain(0));
      await waitFor(() => expect(within(group).getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-checked', 'false'));
    });

    it('sans heure : pas d’édition, rappels conservés grisés (critère 7)', async () => {
      const task = await open('09:00', [0]);
      await createTaskUseCases(container).update(task.id, { time: null });
      cleanup();
      useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
      render(
        <AppContainerProvider container={container}>
          <TaskDetail />
        </AppContainerProvider>,
      );
      const chip = await screen.findByText('À l’heure', { selector: '.ct-task-detail__chip' });
      expect(chip).toHaveAttribute('data-inactive', 'true');
      expect(screen.queryByRole('button', { name: 'Modifier les rappels' })).toBeNull();
    });
  });

  describe('iPhone', () => {
    beforeEach(() => mockViewport(440));

    it('les rappels passent par « Modifier » : feuille avec le bloc Rappel, enregistrement des lignes (critère 4)', async () => {
      const task = await open('09:00', [0]);
      expect(screen.queryByRole('button', { name: 'Modifier les rappels' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
      const edit = await screen.findByRole('dialog', { name: 'Modifier la tâche' });
      expect(within(edit).getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(within(edit).getByRole('checkbox', { name: '1 heure' }));
      fireEvent.click(within(edit).getByRole('button', { name: 'Enregistrer' }));
      await waitFor(async () => expect(await stored(task)).toEqual([[60, '2026-09-23T08:00'], [0, '2026-09-23T09:00']]));
    });

    it('bloc Rappel grisé sans heure ; une heure donnée le rend actif (critère 7)', async () => {
      await open(null, []);
      fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
      const edit = await screen.findByRole('dialog', { name: 'Modifier la tâche' });
      expect(within(edit).getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-disabled', 'true');
      expect(within(edit).getByRole('checkbox', { name: '30 min' })).toHaveAttribute('aria-disabled', 'true');
    });
  });
});
