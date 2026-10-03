import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import type { LocalDate, LocalTime } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TaskDetail } from '../tasks/TaskDetail';
import { mockViewport, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026.
describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Renvoyer une tâche datée dans « Un jour » (SD-03), %s', (_name, width) => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday(width < 1024 ? '421' : '422');
    mockViewport(width);
  });
  afterEach(() => teardownSomeday(h));

  async function openDetail(over: Partial<Parameters<ReturnType<typeof createTaskUseCases>['create']>[0]> = {}) {
    const created = await createTaskUseCases(h.container).create({ title: 'Appeler le notaire', spaceId: SPACE_PERSO_ID, date: h.today, time: '10:00' as LocalTime, note: 'Dossier Martin', ...over });
    if (!created.ok) throw new Error('création impossible');
    useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
        <UndoToast />
      </AppContainerProvider>,
    );
    await screen.findByText('Appeler le notaire');
    return created.value;
  }
  const stored = (id: string) => h.container.data.repos.tasks.getById(id as never);
  const somedayTitles = async () => (await h.container.data.repos.tasks.listSomeday('all')).map((task) => task.title);

  it('« Un jour » retire date et heure, la tâche entre en tête de la liste ; espace, note conservés (critères 1 et 4)', async () => {
    await seedSomeday(h, { title: 'Ancienne' });
    const task = await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: true, date: null, time: null, spaceId: SPACE_PERSO_ID, note: 'Dossier Martin' }));
    expect(await somedayTitles()).toEqual(['Appeler le notaire', 'Ancienne']);
  });

  it('message « mise dans « Un jour » » 5 s ; Annuler restaure date, heure et position (critère 3)', async () => {
    await seedSomeday(h, { title: 'Ancienne' });
    const task = await openDetail();
    fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
    const toast = await screen.findByRole('status');
    expect(toast).toHaveTextContent('« Appeler le notaire » mise dans « Un jour »');
    fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: false, date: h.today, time: '10:00', sortOrder: task.sortOrder }));
    expect(await somedayTitles()).toEqual(['Ancienne']);
  });

  it('le badge « reportée » est effacé en entrant dans « Un jour », et revient à l’annulation', async () => {
    const task = await openDetail();
    await h.container.data.repos.tasks.update(task.id, { carriedOver: true });
    cleanup();
    useNavigationStore.getState().closeDetail();
    useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
        <UndoToast />
      </AppContainerProvider>,
    );
    await act(async () => {
      await createTaskUseCases(h.container).moveToSomeday([task.id]);
    });
    expect(await stored(task.id)).toMatchObject({ someday: true, carriedOver: false });
    await h.container.undo.undoLast();
    expect(await stored(task.id)).toMatchObject({ someday: false, carriedOver: true });
  });

  it('les rappels sont conservés, inactifs : grisés dans la fiche (critère 5)', async () => {
    const task = await openDetail({ reminderOffsets: [0, 30] });
    fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: true }));
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).toHaveLength(2);
    await waitFor(() => expect(document.querySelectorAll('.ct-task-detail__chip[data-inactive="true"]')).toHaveLength(2));
  });

  it('une tâche récurrente : « Un jour » grisé avec l’aide « Arrêtez d’abord la répétition » ; rien ne change (QB-11, critère 6)', async () => {
    const task = await openDetail({ recurrence: defaultRecurrence('daily', h.today) });
    const button = screen.getByRole('button', { name: 'Un jour' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('Arrêtez d’abord la répétition');
    fireEvent.click(button);
    await act(async () => undefined);
    expect(await stored(task.id)).toMatchObject({ someday: false, date: h.today });
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });

  it('une tâche terminée ne propose pas l’action (critère 7)', async () => {
    const task = await openDetail();
    cleanup();
    await h.container.data.repos.tasks.complete(task.id, '2026-10-02T09:00:00.000Z' as never);
    useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
      </AppContainerProvider>,
    );
    await screen.findByText('Appeler le notaire');
    expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
  });

  it('une tâche déjà dans « Un jour » ne propose pas l’action', async () => {
    const task = await seedSomeday(h, { title: 'Appeler le notaire' });
    useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
      </AppContainerProvider>,
    );
    await screen.findByText('Appeler le notaire');
    expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
  });
});

describe('Choix de date : puce « Un jour » (SD-03 critères 2 et 6, PC)', () => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday('423');
    mockViewport(1280);
  });
  afterEach(() => teardownSomeday(h));

  async function openDetail(over: Partial<Parameters<ReturnType<typeof createTaskUseCases>['create']>[0]> = {}) {
    const created = await createTaskUseCases(h.container).create({ title: 'Appeler le notaire', spaceId: SPACE_PRO_ID, date: h.today, time: '10:00' as LocalTime, ...over });
    if (!created.ok) throw new Error('création impossible');
    useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
        <UndoToast />
      </AppContainerProvider>,
    );
    await screen.findByText('Appeler le notaire');
    return created.value;
  }
  const stored = (id: string) => h.container.data.repos.tasks.getById(id as never);

  it('choisir « Un jour » dans le champ de date a le même effet que le bouton, avec message et Annuler', async () => {
    const task = await openDetail();
    fireEvent.click(screen.getByRole('button', { name: /^Date de la tâche : / }));
    fireEvent.click(await screen.findByLabelText('Date de la tâche'));
    fireEvent.click(await screen.findByRole('button', { name: 'Un jour', pressed: false }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: true, date: null, time: null }));
    expect(await screen.findByRole('status')).toHaveTextContent('« Appeler le notaire » mise dans « Un jour »');
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: false, date: h.today, time: '10:00' }));
  });

  it('tâche récurrente : la puce est grisée avec l’aide, la choisir ou saisir « un jour » ne change rien', async () => {
    const task = await openDetail({ recurrence: defaultRecurrence('daily', '2026-10-02' as LocalDate) });
    fireEvent.click(screen.getByRole('button', { name: /^Date de la tâche : / }));
    const field = await screen.findByLabelText('Date de la tâche');
    fireEvent.click(field);
    const chip = (await screen.findAllByRole('button', { name: 'Un jour' })).find((button) => button.classList.contains('ct-date-editor__chip'));
    if (!chip) throw new Error('puce « Un jour » absente');
    expect(chip).toHaveAttribute('aria-disabled', 'true');
    expect(chip).toHaveAccessibleDescription('Arrêtez d’abord la répétition');
    fireEvent.click(chip);
    fireEvent.change(field, { target: { value: 'un jour' } });
    expect(screen.getAllByText('Arrêtez d’abord la répétition').length).toBeGreaterThan(0);
    fireEvent.keyDown(field, { key: 'Enter' });
    await act(async () => undefined);
    expect(await stored(task.id)).toMatchObject({ someday: false, date: h.today });
  });
});
