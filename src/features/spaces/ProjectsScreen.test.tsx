import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { SettingsScreen } from '../settings/SettingsScreen';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { SpacesScreen } from './SpacesScreen';
import { seedProject } from './testKit';

describe('Projets dans Réglages (ES-04)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('e5006');
  });
  afterEach(() => teardownToday(h));

  const renderSpaces = () =>
    render(
      <AppContainerProvider container={h.container}>
        <SpacesScreen />
      </AppContainerProvider>,
    );
  const section = (space: string) => screen.getByRole('region', { name: `Projets de l’espace ${space}` });
  const names = (space: string) => within(section(space)).queryAllByRole('listitem').map((item) => item.querySelector('.ct-projects__name')?.textContent);
  const addProject = async (space: string, name: string, color?: string) => {
    fireEvent.click(within(section(space)).getByRole('button', { name: 'Ajouter un projet' }));
    fireEvent.change(within(section(space)).getByLabelText('Nom du projet'), { target: { value: name } });
    if (color) fireEvent.click(within(section(space)).getByRole('radio', { name: color }));
    fireEvent.click(within(section(space)).getByRole('button', { name: 'Ajouter' }));
  };

  it('ajoute « Mission client » à Pro : il apparaît sous l’espace, couleur de l’espace par défaut, compteur 0 → 1 (critères 1, 3)', async () => {
    const view = render(
      <AppContainerProvider container={h.container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Espaces et projets : Pro (0) · Perso (0)' })).toBeInTheDocument();
    view.unmount();

    renderSpaces();
    await screen.findByRole('region', { name: 'Projets de l’espace Pro' });
    await addProject('Pro', 'Mission client');
    await waitFor(() => expect(names('Pro')).toEqual(['Mission client']));
    const [created] = await h.container.data.repos.projects.listForFilter(SPACE_PRO_ID);
    expect(created).toMatchObject({ name: 'Mission client', color: '#2f6b7a', archived: false, sortOrder: 1 });
    expect(useAppStore.getState().projects).toHaveLength(1);
    expect(names('Perso')).toEqual([]);
  });

  it('la ligne de Réglages compte les projets actifs : 2 → 3, un projet archivé n’est plus compté (critère 1)', async () => {
    await seedProject(h, SPACE_PRO_ID, 'Alpha');
    await seedProject(h, SPACE_PRO_ID, 'Bravo');
    await seedProject(h, SPACE_PRO_ID, 'Vieux', { archived: true });
    await seedProject(h, SPACE_PERSO_ID, 'Maison');
    render(
      <AppContainerProvider container={h.container}>
        <SettingsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Espaces et projets : Pro (2) · Perso (1)' })).toBeInTheDocument();
  });

  it('choisit une couleur de la palette fixe pour le projet (critère 3)', async () => {
    renderSpaces();
    await screen.findByRole('region', { name: 'Projets de l’espace Pro' });
    fireEvent.click(within(section('Pro')).getByRole('button', { name: 'Ajouter un projet' }));
    const group = within(section('Pro')).getByRole('radiogroup', { name: 'Couleur du projet' });
    expect(within(group).getAllByRole('radio')).toHaveLength(8);
    expect(within(group).getByRole('radio', { name: 'Bleu canard' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(section('Pro')).getByRole('button', { name: 'Annuler' }));
    await addProject('Pro', 'Refonte site', 'Prune');
    await waitFor(() => expect(names('Pro')).toEqual(['Refonte site']));
    expect((await h.container.data.repos.projects.listForFilter(SPACE_PRO_ID))[0]?.color).toBe('#6a3d6e');
  });

  it('nom : 1 à 50 caractères, unique dans l’espace sans tenir compte de la casse, le même nom reste possible dans l’autre (critère 2)', async () => {
    await seedProject(h, SPACE_PRO_ID, 'Mission client');
    renderSpaces();
    await screen.findByText('Mission client');
    for (const [value, message] of [
      ['  ', 'Le nom du projet ne peut pas être vide.'],
      ['x'.repeat(51), 'Le nom du projet ne doit pas dépasser 50 caractères.'],
      ['MISSION CLIENT', 'Un projet de cet espace porte déjà ce nom.'],
    ] as const) {
      fireEvent.click(within(section('Pro')).getByRole('button', { name: 'Ajouter un projet' }));
      fireEvent.change(within(section('Pro')).getByLabelText('Nom du projet'), { target: { value } });
      fireEvent.click(within(section('Pro')).getByRole('button', { name: 'Ajouter' }));
      expect(await within(section('Pro')).findByRole('alert')).toHaveTextContent(message);
      fireEvent.click(within(section('Pro')).getByRole('button', { name: 'Annuler' }));
    }
    expect(names('Pro')).toEqual(['Mission client']);
    await addProject('Perso', 'Mission client');
    await waitFor(() => expect(names('Perso')).toEqual(['Mission client']));
  });

  it('modifie le nom et la couleur d’un projet (critères 2, 3)', async () => {
    const project = await seedProject(h, SPACE_PRO_ID, 'Mission client');
    renderSpaces();
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier le projet Mission client' }));
    fireEvent.change(within(section('Pro')).getByLabelText('Nom du projet'), { target: { value: 'Mission Alpha' } });
    fireEvent.click(within(section('Pro')).getByRole('radio', { name: 'Violet' }));
    fireEvent.click(within(section('Pro')).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(names('Pro')).toEqual(['Mission Alpha']));
    expect(await h.container.data.repos.projects.getById(project.id)).toMatchObject({ name: 'Mission Alpha', color: '#5b43a8' });
  });

  it('archive puis désarchive : le projet n’est plus listé parmi les actifs (critère 5)', async () => {
    const project = await seedProject(h, SPACE_PRO_ID, 'Mission client');
    renderSpaces();
    fireEvent.click(await screen.findByRole('button', { name: 'Archiver le projet Mission client' }));
    await waitFor(() => expect(names('Pro')).toEqual([]));
    const archivedGroup = within(section('Pro')).getByRole('group', { name: 'Archivés' });
    expect(within(archivedGroup).getByText('Mission client')).toBeInTheDocument();
    expect((await h.container.data.repos.projects.getById(project.id))?.archived).toBe(true);
    expect(await h.container.data.repos.projects.listForFilter(SPACE_PRO_ID)).toEqual([]);
    fireEvent.click(within(archivedGroup).getByRole('button', { name: 'Désarchiver le projet Mission client' }));
    await waitFor(() => expect(names('Pro')).toEqual(['Mission client']));
    expect((await h.container.data.repos.projects.getById(project.id))?.archived).toBe(false);
  });

  it('ordre : boutons et touches ↑ / ↓ sur la poignée changent l’ordre de la liste (critère 8)', async () => {
    await seedProject(h, SPACE_PRO_ID, 'Alpha');
    await seedProject(h, SPACE_PRO_ID, 'Bravo');
    await seedProject(h, SPACE_PRO_ID, 'Charlie');
    renderSpaces();
    await screen.findByText('Alpha');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer le projet Alpha' }), { key: 'ArrowDown' });
    await waitFor(() => expect(names('Pro')).toEqual(['Bravo', 'Alpha', 'Charlie']));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer le projet Charlie' }), { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(names('Pro')).toEqual(['Bravo', 'Charlie', 'Alpha']));
    expect((await h.container.data.repos.projects.listForFilter(SPACE_PRO_ID)).map((p) => p.name)).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('les archivés suivent les actifs dans l’ordre ; réordonner ne casse rien', async () => {
    await seedProject(h, SPACE_PRO_ID, 'Alpha');
    await seedProject(h, SPACE_PRO_ID, 'Vieux', { archived: true });
    await seedProject(h, SPACE_PRO_ID, 'Bravo');
    renderSpaces();
    await screen.findByText('Alpha');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer le projet Alpha' }), { key: 'ArrowDown' });
    await waitFor(() => expect(names('Pro')).toEqual(['Bravo', 'Alpha']));
    const all = (await h.container.data.repos.projects.listForFilter(SPACE_PRO_ID, { includeArchived: true })).map((p) => [p.name, p.sortOrder]);
    expect(all).toEqual([
      ['Bravo', 1],
      ['Alpha', 2],
      ['Vieux', 3],
    ]);
  });

  it('un projet de Pro n’apparaît jamais dans Perso', async () => {
    await seedProject(h, SPACE_PRO_ID, 'Mission client');
    renderSpaces();
    await screen.findByText('Mission client');
    expect(names('Perso')).toEqual([]);
    expect(within(section('Perso')).getByText('Aucun projet pour l’instant.')).toBeInTheDocument();
  });
});
