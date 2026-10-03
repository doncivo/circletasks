import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import type { ProjectId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { mockViewport, renderSomeday, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

/** Titres des lignes, dans l'ordre affiché. */
const titles = (): string[] => Array.from(document.querySelectorAll('.ct-list-row__title')).map((node) => node.textContent ?? '');

describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Liste « Un jour » (SD-01), %s', (_name, width) => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday(width < 1024 ? '401' : '402');
    mockViewport(width);
  });
  afterEach(() => teardownSomeday(h));

  const somedayTasks = () => h.container.data.repos.tasks.listSomeday('all');
  const addField = () => screen.getByRole('textbox', { name: 'Nouvelle tâche sans date' });
  /** PC : le champ remplace le bouton « + Ajouter à « Un jour » ». */
  async function openAddField() {
    if (width >= 1024) fireEvent.click(await screen.findByRole('button', { name: '+ Ajouter à « Un jour »' }));
    return addField();
  }

  it('affiche le titre et le sous-titre au pluriel (critère 6)', async () => {
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    await seedSomeday(h, { title: 'Lire le rapport annuel' });
    renderSomeday(h.container);
    expect(await screen.findByText('2 tâches sans date, à planifier plus tard')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Un jour' })).toBeInTheDocument();
  });

  it('au singulier : « 1 tâche sans date… »', async () => {
    await seedSomeday(h, { title: 'Renouveler le passeport' });
    renderSomeday(h.container);
    expect(await screen.findByText('1 tâche sans date, à planifier plus tard')).toBeInTheDocument();
  });

  it('Entrée crée une tâche sans date ni heure, vide le champ et garde le focus (critères 3 et 9)', async () => {
    renderSomeday(h.container);
    const field = await openAddField();
    fireEvent.change(field, { target: { value: 'Renouveler le passeport' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await waitFor(async () => expect(await somedayTasks()).toHaveLength(1));
    const [task] = await somedayTasks();
    if (!task) throw new Error('tâche absente');
    expect(task).toMatchObject({ title: 'Renouveler le passeport', someday: true, date: null, time: null, spaceId: SPACE_PRO_ID, status: 'todo' });
    await waitFor(() => expect(addField()).toHaveValue(''));
    expect(addField()).toHaveFocus();
    expect(await screen.findByRole('button', { name: 'Renouveler le passeport' })).toBeInTheDocument();
    // Critère 9 : sans heure, aucun rappel.
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).toHaveLength(0);
  });

  it('un titre vide ne crée rien (critère 4)', async () => {
    renderSomeday(h.container);
    const field = await openAddField();
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await act(async () => undefined);
    expect(await somedayTasks()).toHaveLength(0);
  });

  it('la tâche créée prend l’espace du filtre actif (T-01, ES-02)', async () => {
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    renderSomeday(h.container);
    const field = await openAddField();
    fireEvent.change(field, { target: { value: 'Trier les photos' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await waitFor(async () => expect(await somedayTasks()).toHaveLength(1));
    expect((await somedayTasks())[0]?.spaceId).toBe(SPACE_PERSO_ID);
  });

  it('une nouvelle tâche entre en tête de liste (SD-04 critère 2)', async () => {
    await seedSomeday(h, { title: 'Ancienne' });
    renderSomeday(h.container);
    await screen.findByRole('button', { name: 'Ancienne' });
    const field = await openAddField();
    fireEvent.change(field, { target: { value: 'Nouvelle' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await screen.findByRole('button', { name: 'Nouvelle' });
    expect(titles()).toEqual(['Nouvelle', 'Ancienne']);
  });

  it('chaque ligne montre « espace · projet » ; en filtre Pro, l’espace est omis (critère 8)', async () => {
    const project = await h.container.data.repos.projects.create({
      id: newEntityId<ProjectId>(h.container.ids),
      spaceId: SPACE_PRO_ID,
      name: 'Mission client',
      color: '#2F6B7A' as never,
      archived: false,
      sortOrder: 1,
    });
    useAppStore.getState().setProjects([project]);
    await seedSomeday(h, { title: 'Préparer la présentation Q4', projectId: project.id });
    await seedSomeday(h, { title: 'Réparer l’étagère', spaceId: SPACE_PERSO_ID });
    renderSomeday(h.container);
    const row = (await screen.findByRole('button', { name: 'Préparer la présentation Q4' })).closest('.ct-list-row') as HTMLElement;
    expect(row).toHaveTextContent('Pro · Mission client');
    expect((screen.getByRole('button', { name: 'Réparer l’étagère' }).closest('.ct-list-row') as HTMLElement).textContent).toContain('Perso');
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Réparer l’étagère' })).toBeNull());
    expect((screen.getByRole('button', { name: 'Préparer la présentation Q4' }).closest('.ct-list-row') as HTMLElement).textContent).toBe('Préparer la présentation Q4Mission client');
  });

  it('cocher une ligne termine la tâche : elle quitte la liste et le compteur baisse (critère 8)', async () => {
    await seedSomeday(h, { title: 'A' });
    await seedSomeday(h, { title: 'B' });
    renderSomeday(h.container);
    await screen.findByText('2 tâches sans date, à planifier plus tard');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : A' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'A' })).toBeNull());
    expect(screen.getByText('1 tâche sans date, à planifier plus tard')).toBeInTheDocument();
    const done = (await somedayTasks()).find((task) => task.title === 'A');
    expect(done?.status).toBe('done');
    expect(await screen.findByRole('status')).toHaveTextContent('« A » terminée');
  });

  it('le filtre Perso ne garde que les tâches Perso, sous-titre compris (SD-04 critère 3)', async () => {
    await seedSomeday(h, { title: 'Pro 1' });
    await seedSomeday(h, { title: 'Perso 1', spaceId: SPACE_PERSO_ID });
    renderSomeday(h.container);
    await screen.findByText('2 tâches sans date, à planifier plus tard');
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    expect(await screen.findByText('1 tâche sans date, à planifier plus tard')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pro 1' })).toBeNull();
  });

  it('état vide : phrase simple, nommant l’espace sous un filtre', async () => {
    renderSomeday(h.container);
    expect(await screen.findByText('Rien en attente : les tâches sans date arrivent ici.')).toBeInTheDocument();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    expect(await screen.findByText('Aucune tâche « Un jour » dans Perso.')).toBeInTheDocument();
  });
});
