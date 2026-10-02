import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { RecurrenceFields, Task } from '../../domain/model';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { asEntityId, asLocalDate, type DeviceId, type TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from './createTaskUseCases';
import { TaskDetail } from './TaskDetail';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000013');
const MONTHLY_23 = defaultRecurrence('monthly', asLocalDate('2026-09-23'));
const LOYER = 'Payer le loyer';

describe('TaskDetail : modifier ou arrêter une récurrence (T-10)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, new Date(2026, 8, 23, 8).getTime());
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
  });

  afterEach(async () => {
    cleanup();
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function open(rule: RecurrenceFields | null, date = '2026-09-23'): Promise<Task> {
    const created = await createTaskUseCases(container).create({
      title: LOYER,
      spaceId: SPACE_PRO_ID,
      date: asLocalDate(date),
      note: 'virement',
      ...(rule ? { recurrence: rule } : {}),
    });
    if (!created.ok) throw new Error('création impossible');
    useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
    render(
      <AppContainerProvider container={container}>
        <TaskDetail />
        <UndoToast />
      </AppContainerProvider>,
    );
    await screen.findByText(LOYER);
    return created.value;
  }

  const stored = async (id: TaskId) => (await db.data.repos.tasks.getById(id)) as Task;
  const note = () => screen.getByLabelText('Note');
  const editNote = (value: string) => {
    fireEvent.change(note(), { target: { value } });
    fireEvent.blur(note());
  };

  it('le détail affiche la règle avec « Modifier la répétition » et « Arrêter la répétition »', async () => {
    await open(MONTHLY_23);
    expect(await screen.findByTestId('recurrence-detail')).toHaveTextContent('Mensuelle, le 23');
    expect(screen.getByRole('button', { name: 'Modifier la répétition de la tâche' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrêter la répétition' })).toBeInTheDocument();
  });

  it('une tâche simple affiche « Une fois » et ne pose aucune question à la modification de la note', async () => {
    const task = await open(null);
    expect(screen.getByTestId('recurrence-detail')).toHaveTextContent('Une fois');
    editNote('autre note');
    await waitFor(async () => expect((await stored(task.id)).note).toBe('autre note'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('modifier la note d’une occurrence pose la question ; « Cette occurrence » garde les valeurs de la série (critères 1, 2)', async () => {
    const task = await open(MONTHLY_23);
    editNote('chèque');
    const dialog = await screen.findByRole('alertdialog', { name: 'Modifier « Payer le loyer » ?' });
    expect(within(dialog).getByRole('button', { name: 'Cette occurrence' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Toutes les suivantes' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Annuler' })).toHaveFocus();
    expect((await stored(task.id)).note).toBe('virement'); // rien n'est écrit avant le choix

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cette occurrence' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ note: 'chèque', seriesTemplate: { note: 'virement' } }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('« Toutes les suivantes » : la série reprend la note (critère 3)', async () => {
    const task = await open(MONTHLY_23);
    editNote('chèque');
    fireEvent.click(await screen.findByRole('button', { name: 'Toutes les suivantes' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ note: 'chèque', seriesTemplate: null }));
  });

  it('« Annuler » (message ou Ctrl+Z) d’une modification remet l’ancienne note dans le champ (critère 8)', async () => {
    const task = await open(MONTHLY_23);
    editNote('chèque');
    fireEvent.click(await screen.findByRole('button', { name: 'Cette occurrence' }));
    await waitFor(() => expect(container.taskEntities.get(task.id)?.note).toBe('chèque'));
    await container.undo.undoLast();
    await waitFor(() => expect(note()).toHaveValue('virement'));
    expect((await stored(task.id)).seriesTemplate).toBeNull();
  });

  it('« Annuler » dans la question ne change rien et rétablit la note', async () => {
    const task = await open(MONTHLY_23);
    editNote('chèque');
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(note()).toHaveValue('virement');
    expect((await stored(task.id)).note).toBe('virement');
  });

  it('fermer la fiche avec une note modifiée pose la question avant de fermer', async () => {
    await open(MONTHLY_23);
    editNote('chèque');
    await screen.findByRole('alertdialog');
    expect(useNavigationStore.getState().detail).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); // ferme la question
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useNavigationStore.getState().detail).not.toBeNull();
  });

  it('modifier l’icône pose la même question', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(screen.getByRole('button', { name: 'Icône' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Icône téléphone' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cette occurrence' }));
    await waitFor(async () => expect((await stored(task.id)).icon).not.toBeNull());
  });

  it('règle : « Après 6 occurrences » ; seul « Toutes les suivantes » est proposé ; le détail affiche « 6 fois » (critères 4, 5, 8)', async () => {
    await open(MONTHLY_23);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la répétition de la tâche' }));
    fireEvent.click(screen.getByRole('button', { name: /Autre : tous les N jours/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Après' }));
    fireEvent.change(screen.getByLabelText('Nombre d’occurrences'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Modifier la répétition ?' });
    expect(within(dialog).queryByRole('button', { name: 'Cette occurrence' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Toutes les suivantes' }));
    await waitFor(() => expect(screen.getByTestId('recurrence-detail')).toHaveTextContent('6 fois'));
  });

  it('règle : « Fin le 31 déc. 2026 » s’affiche dans le détail (critère 5, 8)', async () => {
    await open(MONTHLY_23);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la répétition de la tâche' }));
    fireEvent.click(screen.getByRole('button', { name: /Autre : tous les N jours/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Fin le' }));
    fireEvent.change(screen.getByLabelText('Date de fin'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Toutes les suivantes' }));
    await waitFor(() => expect(screen.getByTestId('recurrence-detail')).toHaveTextContent(/jusqu.au 31 déc\. 2026/));
  });

  it('règle : une fin déjà dépassée est refusée avec un message clair (critère 9)', async () => {
    await open(defaultRecurrence('monthly', asLocalDate('2026-09-01')), '2026-09-01');
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la répétition de la tâche' }));
    fireEvent.click(screen.getByRole('button', { name: /Autre : tous les N jours/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Fin le' }));
    fireEvent.change(screen.getByLabelText('Date de fin'), { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Toutes les suivantes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La date de fin est déjà passée.');
    expect(screen.getByTestId('recurrence-detail')).toHaveTextContent('Mensuelle, le 1ᵉʳ');
  });

  it('« Une fois » choisi dans l’éditeur arrête la répétition', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la répétition de la tâche' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Une fois' }));
    fireEvent.click(screen.getByRole('button', { name: 'Valider' }));
    await waitFor(async () => expect((await stored(task.id)).recurrenceId).toBeNull());
  });

  it('« Arrêter la répétition » : le détail affiche « Une fois » (critère 6)', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(await screen.findByRole('button', { name: 'Arrêter la répétition' }));
    await waitFor(() => expect(screen.getByTestId('recurrence-detail')).toHaveTextContent('Une fois'));
    expect((await stored(task.id)).recurrenceId).toBeNull();
    expect(screen.getByRole('button', { name: 'Rendre la tâche récurrente' })).toBeInTheDocument();
  });

  it('annuler (Ctrl+Z / message) un arrêt rétablit la règle affichée', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(await screen.findByRole('button', { name: 'Arrêter la répétition' }));
    await waitFor(() => expect(screen.getByTestId('recurrence-detail')).toHaveTextContent('Une fois'));
    await container.undo.undoLast();
    await waitFor(() => expect(screen.getByTestId('recurrence-detail')).toHaveTextContent('Mensuelle, le 23'));
    expect((await stored(task.id)).recurrenceId).not.toBeNull();
  });

  it('Reporter une occurrence pose la question ; « Cette occurrence » garde l’ancre de la série (critère 4)', async () => {
    const task = await open({ ...defaultRecurrence('daily', asLocalDate('2026-09-23')), interval: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Reporter' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Demain' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reporter « Payer le loyer » ?' });
    expect((await stored(task.id)).date).toBe('2026-09-23'); // rien avant le choix
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cette occurrence' }));
    await waitFor(async () => expect(await stored(task.id)).toMatchObject({ date: '2026-09-24', seriesTemplate: { date: '2026-09-23' } }));
  });

  it('Reporter : « Annuler » dans la question ne change rien', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(screen.getByRole('button', { name: 'Reporter' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Demain' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((await stored(task.id)).date).toBe('2026-09-23');
  });

  it('supprimer une occurrence : « Cette occurrence » supprime et génère la suivante ; la fiche se ferme (critère 7)', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Supprimer « Payer le loyer » ?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cette occurrence' }));
    await waitFor(() => expect(useNavigationStore.getState().detail).toBeNull());
    expect((await db.data.repos.tasks.getById(task.id))).toBeNull();
    const live = await db.data.repos.tasks.listByRecurrence(task.recurrenceId as never);
    expect(live.map((t) => t.date)).toEqual(['2026-10-23']);
  });

  it('supprimer une occurrence : « Toutes les suivantes » arrête la série', async () => {
    const task = await open(MONTHLY_23);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Toutes les suivantes' }));
    await waitFor(() => expect(useNavigationStore.getState().detail).toBeNull());
    expect(await db.data.repos.recurrences.getById(task.recurrenceId as never)).toBeNull();
  });

  it('supprimer une tâche simple garde la confirmation habituelle', async () => {
    await open(null);
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Supprimer « Payer le loyer » ?' });
    expect(within(dialog).queryByRole('button', { name: 'Cette occurrence' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
  });
});
