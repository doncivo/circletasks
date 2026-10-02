import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NewReminder, ReminderOffsetMin } from '../../domain/model';
import type { LocalTime, ReminderId, RoutineId } from '../../domain/types';
import { newEntityId } from '../../domain/id';
import { mockViewport, renderRoutines, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026.
const save = () => screen.getByRole('button', { name: 'Enregistrer' });
const timeButton = () => screen.getByRole('button', { name: /^Heure de la routine/ });
const box = (name: string) => screen.getByRole('checkbox', { name });

async function seedReminders(h: RoutinesHarness, id: RoutineId, offsets: readonly ReminderOffsetMin[], fireDate = '2026-10-02', time = '18:00'): Promise<void> {
  const reminders: NewReminder[] = offsets.map((offsetMin) => ({
    id: newEntityId<ReminderId>(h.container.ids),
    targetType: 'routine',
    targetId: id,
    offsetMin,
    fireAt: `${fireDate}T${time}` as never,
  }));
  await h.container.data.repos.reminders.replaceForTarget({ type: 'routine', id }, reminders);
}

describe('Routines : heure et rappel (R-02), PC', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('221');
    mockViewport(1440);
  });
  afterEach(() => teardownRoutines(h));

  async function openCreate(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    await screen.findByRole('form', { name: 'Nouvelle routine' });
    fireEvent.change(screen.getByLabelText('Nom de la routine'), { target: { value: 'Séance d’étirements' } });
  }

  it('sans heure : les cases de rappel sont grisées et non cochables (critère 5, QB-07)', async () => {
    renderRoutines(h.container);
    await openCreate();
    expect(timeButton()).toHaveTextContent('Sans heure');
    for (const name of ['À l’heure', '30 min']) {
      expect(box(name)).toHaveAttribute('aria-disabled', 'true');
      expect(box(name)).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(box(name));
      expect(box(name)).toHaveAttribute('aria-checked', 'false');
    }
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const [routine] = await h.container.data.repos.routines.listForFilter('all');
    expect(routine?.time).toBeNull();
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine?.id as RoutineId })).toEqual([]);
  });

  it('champ HH:MM au clavier : « 7h30 » devient 07:30, les cases deviennent actives, « À l’heure » cochée d’office (critères 1, 5, 8, QB-08)', async () => {
    renderRoutines(h.container);
    await openCreate();
    fireEvent.click(timeButton());
    const input = screen.getByLabelText('Heure (HH:MM)');
    fireEvent.change(input, { target: { value: '7h30' } });
    fireEvent.blur(input);
    expect(input).toHaveValue('07:30');
    expect(timeButton()).toHaveTextContent('07:30');
    expect(box('À l’heure')).toHaveAttribute('aria-disabled', 'false');
    expect(box('À l’heure')).toHaveAttribute('aria-checked', 'true');
    expect(box('30 min')).toHaveAttribute('aria-checked', 'false');
  });

  it('heure invalide : message, l’heure précédente est gardée', async () => {
    renderRoutines(h.container);
    await openCreate();
    fireEvent.click(timeButton());
    const input = screen.getByLabelText('Heure (HH:MM)');
    fireEvent.change(input, { target: { value: '25h' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Heure non comprise');
    expect(timeButton()).toHaveTextContent('Sans heure');
  });

  it('enregistre l’heure et un rappel par avance cochée, échéance de la prochaine occurrence (critère 4)', async () => {
    renderRoutines(h.container);
    await openCreate();
    fireEvent.click(timeButton());
    fireEvent.change(screen.getByLabelText('Heure (HH:MM)'), { target: { value: '07:30' } });
    fireEvent.click(box('30 min'));
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const [routine] = await h.container.data.repos.routines.listForFilter('all');
    expect(routine?.time).toBe('07:30');
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine?.id as RoutineId });
    expect(reminders.map((reminder) => [reminder.targetType, reminder.offsetMin, reminder.fireAt])).toEqual([
      ['routine', 30, '2026-10-02T07:00'],
      ['routine', 0, '2026-10-02T07:30'],
    ]);
    expect(screen.getByRole('heading', { name: 'Séance d’étirements' }).closest('article')).toHaveTextContent('07:30 · Pro');
  });

  it('décocher « À l’heure » : aucun rappel enregistré, l’heure reste', async () => {
    renderRoutines(h.container);
    await openCreate();
    fireEvent.click(timeButton());
    fireEvent.change(screen.getByLabelText('Heure (HH:MM)'), { target: { value: '07:30' } });
    fireEvent.click(box('À l’heure'));
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const [routine] = await h.container.data.repos.routines.listForFilter('all');
    expect(routine?.time).toBe('07:30');
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine?.id as RoutineId })).toEqual([]);
  });

  it('effacer l’heure d’une routine qui avait des rappels : cases grisées, rappels conservés mais inactifs (R-02 critère 5, N-02 critère 7)', async () => {
    const routine = await seedRoutine(h, { title: 'Sport', time: '18:00' as LocalTime });
    await seedReminders(h, routine.id as RoutineId, [0, 30]);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Sport' }));
    await screen.findByRole('form', { name: 'Modifier la routine' });
    expect(box('À l’heure')).toHaveAttribute('aria-checked', 'true');
    expect(box('30 min')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(timeButton());
    fireEvent.click(screen.getByRole('button', { name: 'Effacer l’heure' }));
    expect(timeButton()).toHaveTextContent('Sans heure');
    expect(box('À l’heure')).toHaveAttribute('aria-disabled', 'true');
    expect(box('À l’heure')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    expect((await h.container.data.repos.routines.getById(routine.id))?.time).toBeNull();
    expect((await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine.id as RoutineId })).map((r) => r.offsetMin).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it('« Plus… » ouvre les six avances ; une avance rare déjà posée est visible ; enregistrer pose les avances cochées (N-02 critères 2, 4)', async () => {
    const routine = await seedRoutine(h, { title: 'Sport', time: '18:00' as LocalTime });
    await seedReminders(h, routine.id as RoutineId, [0, 15]);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Sport' }));
    await screen.findByRole('form', { name: 'Modifier la routine' });
    // 15 min n'est pas un rappel rapide : la liste est dépliée d'office.
    expect(box('15 min')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(box('1 jour'));
    fireEvent.click(box('À l’heure'));
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const rows = await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine.id as RoutineId });
    expect(rows.map((r) => r.offsetMin).sort((a, b) => a - b)).toEqual([15, 1440]);
  });

  it('changer l’heure : les rappels gardent leur avance, l’échéance est recalculée ; les autres avances (N-02) sont conservées (critère 6)', async () => {
    const routine = await seedRoutine(h, { title: 'Sport', time: '18:00' as LocalTime });
    await seedReminders(h, routine.id as RoutineId, [30, 15]);
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Sport' }));
    await screen.findByRole('form', { name: 'Modifier la routine' });
    fireEvent.click(timeButton());
    fireEvent.change(screen.getByLabelText('Heure (HH:MM)'), { target: { value: '19:00' } });
    fireEvent.click(save());
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine.id as RoutineId });
    expect(reminders.map((reminder) => [reminder.offsetMin, reminder.fireAt])).toEqual([
      [30, '2026-10-02T18:30'],
      [15, '2026-10-02T18:45'],
    ]);
  });

  it('l’heure d’une routine est affichée sur 24 h avec zéro initial', async () => {
    await seedRoutine(h, { title: 'Tôt', time: '07:05' as LocalTime });
    renderRoutines(h.container);
    expect(await screen.findByText('07:05 · Pro')).toBeInTheDocument();
    expect(screen.queryByText(/ 7:05/)).toBeNull();
  });
});

describe('Routines : heure et rappel (R-02), iPhone', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('222');
    mockViewport(440);
  });
  afterEach(() => teardownRoutines(h));

  it('roues Heures et Minutes (« — » = sans heure), minutes grisées sans heure (critère 1)', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    const form = await screen.findByRole('form', { name: 'Nouvelle routine' });
    fireEvent.change(within(form).getByLabelText('Nom de la routine'), { target: { value: 'Lire' } });
    fireEvent.click(within(form).getByRole('button', { name: /^Heure de la routine/ }));
    const hours = within(form).getByRole('spinbutton', { name: 'Heures' });
    const minutes = within(form).getByRole('spinbutton', { name: 'Minutes' });
    expect(minutes).toHaveAttribute('aria-disabled', 'true');
    for (let i = 0; i < 22; i += 1) fireEvent.keyDown(hours, { key: 'ArrowUp' }); // — -> 00 -> … -> 21
    expect(within(form).getByRole('button', { name: /^Heure de la routine : 21:00/ })).toBeInTheDocument();
    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(minutes, { key: 'ArrowUp' });
    expect(within(form).getByRole('button', { name: /^Heure de la routine : 21:30/ })).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const [routine] = await h.container.data.repos.routines.listForFilter('all');
    expect(routine?.time).toBe('21:30');
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'routine', id: routine?.id as RoutineId });
    expect(reminders.map((reminder) => reminder.offsetMin)).toEqual([0]); // « À l'heure » par défaut (QB-08)
  });
});
