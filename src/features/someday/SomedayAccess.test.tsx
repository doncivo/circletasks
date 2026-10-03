import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { renderToday, seedTask } from '../today/testKit';
import { somedayStore } from './somedayStore';
import { mockViewport, renderSomeday, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

describe('Accès à « Un jour » depuis Aujourd’hui (SD-01 critères 1, 2, 5, 6, 7)', () => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday('403');
  });
  afterEach(() => teardownSomeday(h));

  it('l’icône horloge porte le nombre de tâches non terminées du filtre actif, sans badge à 0 (critère 6)', async () => {
    mockViewport(440);
    renderToday(h.container);
    expect(await screen.findByRole('button', { name: 'Un jour' })).toBeInTheDocument();
    for (let n = 1; n <= 6; n += 1) await seedSomeday(h, { title: `Tâche ${String(n)}`, ...(n <= 2 ? { spaceId: SPACE_PERSO_ID } : {}) });
    const button = await screen.findByRole('button', { name: 'Un jour, 6 tâches' });
    expect(within(button).getByText('6')).toBeInTheDocument();
    // Le compteur suit le filtre d'espace global.
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    expect(await screen.findByRole('button', { name: 'Un jour, 2 tâches' })).toBeInTheDocument();
  });

  it('au singulier, et sans badge à zéro', async () => {
    mockViewport(440);
    renderToday(h.container);
    const empty = await screen.findByRole('button', { name: 'Un jour' });
    expect(empty.querySelector('.ct-someday-button__badge')).toBeNull();
    await seedSomeday(h, { title: 'Seule' });
    // La liste est lue au premier affichage : on republie la tâche pour le test sans rouvrir l'écran.
    await act(async () => {
      await somedayStore.get(h.container).getState().load();
    });
    const one = await screen.findByRole('button', { name: 'Un jour, 1 tâche' });
    expect(within(one).getByText('1')).toBeInTheDocument();
  });

  it('les tâches « Un jour » n’apparaissent pas dans Aujourd’hui (critère 7)', async () => {
    mockViewport(440);
    await seedSomeday(h, { title: 'Sans date' });
    await seedTask(h, { title: 'Du jour' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Du jour' });
    expect(screen.queryByRole('button', { name: 'Sans date' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Un jour, 1 tâche' })).toBeInTheDocument();
  });

  it('iPhone : toucher l’icône ouvre l’écran plein, « Retour » revient à Aujourd’hui (critère 1)', async () => {
    mockViewport(440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Un jour' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'someday' });
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Retour' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'today' });
  });

  it('PC : le panneau s’ouvre à droite, « Fermer le panneau » et Échap le ferment (critère 2)', async () => {
    mockViewport(1280);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Un jour' }));
    expect(useNavigationStore.getState().route).toMatchObject({ screen: 'someday' });
    renderSomeday(h.container);
    const panel = await screen.findByRole('complementary', { name: 'Un jour' });
    expect(panel).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Fermer le panneau' }));
    expect(useNavigationStore.getState().route).toMatchObject({ screen: 'today' });

    act(() => useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'someday' }));
    h.container.shortcuts.handle({ key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false });
    await waitFor(() => expect(useNavigationStore.getState().route).toMatchObject({ screen: 'today' }));
  });

  it('PC : une fiche ouverte prend la place du panneau', async () => {
    mockViewport(1280);
    const task = await seedSomeday(h, { title: 'À ouvrir' });
    renderSomeday(h.container);
    expect(await screen.findByRole('complementary', { name: 'Un jour' })).toBeInTheDocument();
    act(() => useNavigationStore.getState().openDetail({ type: 'task', id: task.id }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Un jour' })).toBeNull());
  });

  it('le bouton « + » ouvre la feuille avec « Un jour » présélectionné ; la tâche créée est sans date (critère 5)', async () => {
    mockViewport(440);
    renderSomeday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(within(dialog).getByRole('button', { name: 'Un jour' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Renouveler le passeport' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect(await h.container.data.repos.tasks.listSomeday('all')).toHaveLength(1));
    const [task] = await h.container.data.repos.tasks.listSomeday('all');
    expect(task).toMatchObject({ title: 'Renouveler le passeport', someday: true, date: null, time: null });
  });
});
