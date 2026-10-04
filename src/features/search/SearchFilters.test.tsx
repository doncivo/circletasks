import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../app/appStore';
import { mockViewport, pressCtrlK, renderSearchShell, searchField, setupSearch, teardownSearch, typeQuery, insertTask, SPACE_PERSO_ID, SPACE_PRO_ID, type SearchHarness } from './testKit';

const STAMP = `'2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'`;

const chip = (name: string): HTMLSelectElement => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const choose = async (name: string, label: string): Promise<void> => {
  const select = chip(name);
  const option = within(select).getByRole('option', { name: label }) as HTMLOptionElement;
  await act(async () => {
    fireEvent.change(select, { target: { value: option.value } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('Filtres de la recherche (RC-02)', () => {
  let h: SearchHarness;
  beforeEach(async () => {
    h = await setupSearch('502');
  });
  afterEach(() => teardownSearch(h));

  async function seed(): Promise<void> {
    await h.db.driver.execute(`INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES ('p1', '${SPACE_PRO_ID}', 'Mission client', '#2f6b7a', 1, ${STAMP})`);
    useAppStore.getState().setProjects(await h.container.data.repos.projects.listForFilter('all', { includeArchived: true }));
    await insertTask(h, { id: 'tA', title: 'Facture A', space: SPACE_PRO_ID, date: '2026-10-01', projectId: 'p1' });
    await insertTask(h, { id: 'tB', title: 'Facture B', space: SPACE_PRO_ID, date: '2026-09-10', status: 'done' });
    await insertTask(h, { id: 'tC', title: 'Facture C', space: SPACE_PERSO_ID, date: null, someday: true });
    await h.db.driver.execute(`INSERT INTO checklist (id, space_id, title, date, created_at, updated_at, device_id, hlc) VALUES ('c1', '${SPACE_PRO_ID}', 'Facture liste', '2026-10-02', ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e1', '${SPACE_PERSO_ID}', 'Facture événement', '2026-10-10', '2026-10-10', ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO goal (id, space_id, week_start, title, status, created_at, updated_at, device_id, hlc) VALUES ('g1', '${SPACE_PRO_ID}', '2026-09-28', 'Facture objectif', 'open', ${STAMP})`);
  }

  async function openAndSearch(): Promise<void> {
    mockViewport(440);
    renderSearchShell(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Rechercher' }));
    await screen.findByRole('dialog', { name: 'Recherche' });
    await typeQuery('facture');
    await screen.findByText('6 résultats');
  }

  it('propose Espace, Type, Statut et Période, avec des noms accessibles « Filtre Type : Tous » (critères 1 et 9)', async () => {
    await seed();
    await openAndSearch();
    for (const name of ['Filtre Espace : Tout', 'Filtre Type : Tous', 'Filtre Statut : Tous', 'Filtre Période']) expect(chip(name)).toBeInTheDocument();
    // « Projet » seulement pour un espace unique (critère 2).
    expect(screen.queryByRole('combobox', { name: /Filtre Projet/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Réinitialiser' })).toBeNull();
    expect(within(chip('Filtre Type : Tous')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Tous', 'Tâches', 'Routines', 'Événements', 'Checklists', 'Objectifs']);
  });

  it('Espace : filtre les résultats et le compteur sans toucher au filtre global (critères 1 et 7)', async () => {
    await seed();
    await openAndSearch();
    await choose('Filtre Espace : Tout', 'Pro');
    expect(await screen.findByText('4 résultats')).toBeInTheDocument();
    expect(chip('Filtre Espace : Pro')).toBeInTheDocument();
    expect(useAppStore.getState().spaceFilter).toBe('all');
    await choose('Filtre Espace : Pro', 'Perso');
    expect(await screen.findByText('2 résultats')).toBeInTheDocument();
    expect(useAppStore.getState().spaceFilter).toBe('all');
  });

  it('Projet : la puce apparaît sous un espace qui a des projets et ne garde que leurs tâches (critère 2)', async () => {
    await seed();
    await openAndSearch();
    await choose('Filtre Espace : Tout', 'Pro');
    await choose('Filtre Projet : tous', 'Mission client');
    expect(await screen.findByText('1 résultat')).toBeInTheDocument();
    expect(chip('Filtre Projet : Mission client')).toBeInTheDocument();
    // Perso n'a aucun projet : la puce disparaît.
    await choose('Filtre Espace : Pro', 'Perso');
    expect(screen.queryByRole('combobox', { name: /Filtre Projet/ })).toBeNull();
    expect(await screen.findByText('2 résultats')).toBeInTheDocument();
  });

  it('Type : ne garde que les résultats du type choisi (critère 3)', async () => {
    await seed();
    await openAndSearch();
    await choose('Filtre Type : Tous', 'Checklists');
    expect(await screen.findByText('1 résultat')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Checklists · 1']);
    expect(chip('Filtre Type : Checklists')).toBeInTheDocument();
  });

  it('Statut : « À faire » et « Fait » ne gardent que tâches et objectifs (critère 4)', async () => {
    await seed();
    await openAndSearch();
    await choose('Filtre Statut : Tous', 'À faire');
    expect(await screen.findByText('3 résultats')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['Tâches · 2', 'Objectifs · 1']);
    await choose('Filtre Statut : À faire', 'Fait');
    expect(await screen.findByText('1 résultat')).toBeInTheDocument();
    expect(screen.getByText('B', { exact: false, selector: 'span' })).toBeInTheDocument();
  });

  it('Période : Cette semaine, Ce mois, dates choisies ; les éléments sans date sont exclus (critère 5)', async () => {
    await seed();
    await openAndSearch();
    await choose('Filtre Période', 'Cette semaine');
    // Jour figé : ven. 2 oct. 2026 (semaine du 28 sept. au 4 oct.) : tâche A (1er oct.), checklist (2 oct.), objectif (semaine du 28).
    expect(await screen.findByText('3 résultats')).toBeInTheDocument();
    expect(chip('Filtre Période : Cette semaine')).toBeInTheDocument();
    await choose('Filtre Période : Cette semaine', 'Ce mois');
    expect(await screen.findByText('4 résultats')).toBeInTheDocument();
    await choose('Filtre Période : Ce mois', 'Choisir des dates');
    const from = await screen.findByRole('dialog', { name: 'Début de la période' });
    fireEvent.click(within(from).getByRole('button', { name: 'Suivant' }));
    const to = await screen.findByRole('dialog', { name: 'Fin de la période' });
    await act(async () => {
      fireEvent.click(within(to).getByRole('button', { name: 'Appliquer' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Du 2 oct. au 2 oct. : la checklist (2 oct.) et l'objectif dont la semaine (28 sept. – 4 oct.) contient ce jour ; ni la tâche du 1er, ni « Un jour ».
    expect(await screen.findByText('2 résultats')).toBeInTheDocument();
    expect(chip('Filtre Période : ven. 2 oct.')).toBeInTheDocument();
  });

  it('les filtres se combinent, la puce active est mise en évidence, « Réinitialiser » remet tout à zéro (critère 6)', async () => {
    await seed();
    await openAndSearch();
    await choose('Filtre Espace : Tout', 'Pro');
    await choose('Filtre Statut : Tous', 'À faire');
    expect(await screen.findByText('2 résultats')).toBeInTheDocument();
    expect(chip('Filtre Statut : À faire').closest('.ct-search__chip')).toHaveAttribute('data-active', 'true');
    expect(chip('Filtre Type : Tous').closest('.ct-search__chip')).toHaveAttribute('data-active', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }));
    expect(await screen.findByText('6 résultats')).toBeInTheDocument();
    expect(chip('Filtre Espace : Tout')).toBeInTheDocument();
    expect(chip('Filtre Statut : Tous')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réinitialiser' })).toBeNull();
  });

  it('à l’ouverture l’espace du filtre global est repris ; les filtres ne sont pas mémorisés (critère 7)', async () => {
    await seed();
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    mockViewport(1440);
    renderSearchShell(h.container);
    await screen.findByRole('heading', { level: 1 });
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
    expect(chip('Filtre Espace : Pro')).toBeInTheDocument();
    expect(chip('Filtre Projet : tous')).toBeInTheDocument();
    await choose('Filtre Type : Tous', 'Tâches');
    fireEvent.keyDown(searchField(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PRO_ID);
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
    expect(chip('Filtre Type : Tous')).toBeInTheDocument();
    expect(chip('Filtre Espace : Pro')).toBeInTheDocument();
  });
});
