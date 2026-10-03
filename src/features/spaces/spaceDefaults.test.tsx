import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { renderRoutines } from '../routines/testKit';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** ES-02 : espace par défaut = espace actif (Tout → Pro), sélecteur commun, message « Ajouté dans … » hors filtre. */
describe('Espace des nouveaux éléments (ES-02)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('e5003');
  });
  afterEach(() => teardownToday(h));

  const pressed = (dialog: HTMLElement, name: string) => within(dialog).getByRole('button', { name, pressed: true });

  it('feuille « Nouvelle tâche » : Perso présélectionné sous le filtre Perso, Pro sous Tout (critère 2)', async () => {
    mockViewport(440);
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    renderToday(h.container);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(pressed(dialog, 'Perso')).toBeInTheDocument();
  });

  it('feuille : Tout → Pro ; choisir Perso crée dans Perso, le filtre ne change pas, message « Ajouté dans Perso » sous le filtre Pro (critères 3, 4)', async () => {
    mockViewport(440);
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    renderToday(h.container);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(pressed(dialog, 'Pro')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Perso' }));
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Courses du soir' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const [task] = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(task?.spaceId).toBe(SPACE_PERSO_ID);
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PRO_ID);
    expect(await screen.findByText('Ajouté dans Perso')).toBeInTheDocument();
    // Hors du filtre Pro : la tâche n'est pas dans la liste affichée.
    expect(screen.queryByText('Courses du soir')).toBeNull();
  });

  it('création dans l’espace du filtre : aucun message (critère 4)', async () => {
    mockViewport(440);
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    renderToday(h.container);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Appeler maman' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Appeler maman')).toBeInTheDocument();
    expect(screen.queryByText(/Ajouté dans/)).toBeNull();
  });

  it('saisie en ligne (PC) : espace du filtre, sinon Pro (critères 1, 2)', async () => {
    mockViewport(1440);
    renderToday(h.container);
    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Sous Tout' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await screen.findByText('Sous Tout');
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    fireEvent.change(field, { target: { value: 'Sous Perso' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    await screen.findByText('Sous Perso');
    const tasks = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(Object.fromEntries(tasks.map((task) => [task.title, task.spaceId]))).toEqual({ 'Sous Tout': SPACE_PRO_ID, 'Sous Perso': SPACE_PERSO_ID });
    expect(screen.queryByText(/Ajouté dans/)).toBeNull();
  });

  it('formulaire de routine : espace du filtre, Pro sous Tout ; créée dans l’autre espace : « Ajouté dans » (critères 2, 4, 5)', async () => {
    mockViewport(440);
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    let dialog = await screen.findByRole('dialog', { name: 'Nouvelle routine' });
    expect(within(dialog).getByRole('button', { name: 'Perso', pressed: true })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pro' }));
    fireEvent.change(within(dialog).getByLabelText('Nom de la routine'), { target: { value: 'Revue des e-mails' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await h.container.data.repos.routines.listForFilter('all'))[0]?.spaceId).toBe(SPACE_PRO_ID);
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PERSO_ID);
    expect(await screen.findByText('Ajouté dans Pro')).toBeInTheDocument();

    act(() => useAppStore.getState().setSpaceFilter('all'));
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    dialog = await screen.findByRole('dialog', { name: 'Nouvelle routine' });
    expect(within(dialog).getByRole('button', { name: 'Pro', pressed: true })).toBeInTheDocument();
  });
});
