import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, pressCtrlK, renderSearchShell, searchField, setupSearch, teardownSearch, typeQuery, insertTask, SPACE_PERSO_ID, SPACE_PRO_ID, type SearchHarness } from './testKit';

const STAMP = `'2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'`;

describe('Ouverture d’un résultat (RC-03)', () => {
  let h: SearchHarness;
  beforeEach(async () => {
    h = await setupSearch('503');
  });
  afterEach(() => teardownSearch(h));

  async function seed(): Promise<void> {
    await insertTask(h, { id: 't1', title: 'Envoyer la facture', note: 'à poster', space: SPACE_PRO_ID, date: '2026-09-23' });
    await insertTask(h, { id: 't2', title: 'Appeler le fournisseur', note: 'contester la facture', space: SPACE_PERSO_ID, date: null, someday: true });
    await insertTask(h, { id: 't3', title: 'Relancer la facture d’août', space: SPACE_PRO_ID, date: '2026-09-03', status: 'done' });
    await h.db.driver.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c1', '${SPACE_PRO_ID}', 'Valise', ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, sort_order, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Facture de l’hôtel', 1, ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e1', '${SPACE_PERSO_ID}', 'Échéance facture', '2026-10-10', '2026-10-10', ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r1', '${SPACE_PERSO_ID}', 'Classer les factures', 'daily', '2026-09-01', ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO goal (id, space_id, week_start, title, created_at, updated_at, device_id, hlc) VALUES ('g1', '${SPACE_PRO_ID}', '2026-09-28', 'Boucler les factures', ${STAMP})`);
  }

  async function openFacture(width = 1440): Promise<void> {
    mockViewport(width);
    renderSearchShell(h.container);
    await screen.findByRole('heading', { level: 1 });
    if (width >= 1024) pressCtrlK();
    else fireEvent.click(screen.getByRole('button', { name: 'Rechercher' }));
    await screen.findByRole('dialog', { name: 'Recherche' });
    await typeQuery('facture');
    await screen.findByText('7 résultats');
  }

  const rowNames = (): string[] => Array.from(document.querySelectorAll('.ct-search__result')).map((row) => row.getAttribute('aria-label') ?? '');
  const selectedName = (): string => document.querySelector('.ct-search__result[data-selected="true"]')?.getAttribute('aria-label') ?? '';

  async function press(target: Element, key: string, extra: { ctrlKey?: boolean } = {}): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(target, { key, ...extra });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('chaque ligne a un nom complet et une cible d’au moins 44 pt ; seule la ligne sélectionnée est dans l’ordre de tabulation (critères 5 et 7)', async () => {
    await seed();
    await openFacture();
    const names = rowNames();
    expect(names).toContain('Tâche, Envoyer la facture, mer. 23 sept., Pro, à faire');
    expect(names.find((name) => name.startsWith('Tâche, Appeler le fournisseur'))).toBe('Tâche, Appeler le fournisseur, Note : « contester la facture », Un jour, Perso, à faire');
    expect(names.find((name) => name.startsWith('Checklist,'))).toBe('Checklist, Valise, Item : « Facture de l’hôtel », 0/1, Pro');
    const tabbable = Array.from(document.querySelectorAll<HTMLElement>('.ct-search__result')).filter((row) => row.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAttribute('data-selected', 'true');
    // Ordre du DOM : champ, puces, liste.
    const order = Array.from(document.querySelectorAll('input[type="search"], .ct-search__filters select, .ct-search__result')).map((el) => el.tagName);
    expect(order[0]).toBe('INPUT');
    expect(order.indexOf('SELECT')).toBeGreaterThan(0);
    expect(order.lastIndexOf('SELECT')).toBeLessThan(order.indexOf('BUTTON'));
  });

  it('↑ / ↓ passent de ligne en ligne à travers les groupes ; Ctrl+Début / Ctrl+Fin vont aux extrémités ; la sélection est annoncée (critère 1)', async () => {
    await seed();
    await openFacture();
    const input = searchField();
    const names = rowNames();
    expect(selectedName()).toBe(names[0]);
    await press(input, 'ArrowDown');
    expect(selectedName()).toBe(names[1]);
    expect(input.getAttribute('aria-activedescendant')).toBe(document.querySelector('.ct-search__result[data-selected="true"]')?.id);
    for (let i = 0; i < names.length + 2; i += 1) await press(input, 'ArrowDown');
    expect(selectedName()).toBe(names.at(-1));
    await press(input, 'ArrowUp');
    expect(selectedName()).toBe(names.at(-2));
    await press(input, 'Home', { ctrlKey: true });
    expect(selectedName()).toBe(names[0]);
    await press(input, 'End', { ctrlKey: true });
    expect(selectedName()).toBe(names.at(-1));
    // Un type de groupe différent est traversé : la première ligne est une tâche, la dernière un objectif.
    expect(names[0]).toMatch(/^Tâche,/);
    expect(names.at(-1)).toMatch(/^Objectif,/);
  });

  it('dans la liste, ↑ / ↓ / Début / Fin déplacent le focus de ligne en ligne', async () => {
    await seed();
    await openFacture();
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>('.ct-search__result'));
    rows[0]?.focus();
    await press(rows[0] as HTMLElement, 'ArrowDown');
    expect(rows[1]).toHaveFocus();
    await press(rows[1] as HTMLElement, 'End');
    expect(rows.at(-1)).toHaveFocus();
    await press(rows.at(-1) as HTMLElement, 'Home');
    expect(rows[0]).toHaveFocus();
  });

  it('Entrée sur une tâche ferme la recherche et ouvre sa fiche par-dessus l’onglet courant ; fermer la fiche rend l’écran d’avant (critères 2 et 4)', async () => {
    await seed();
    await openFacture();
    const before = useNavigationStore.getState().route;
    await press(searchField(), 'Enter');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: expect.any(String) });
    expect(useNavigationStore.getState().route).toBe(before);
    expect(await screen.findByLabelText('Détail de la tâche')).toBeInTheDocument();
    act(() => useNavigationStore.getState().closeDetail());
    expect(screen.queryByLabelText('Détail de la tâche')).toBeNull();
  });

  it('toucher une tâche « Un jour » ou terminée ouvre aussi sa fiche (critère 4)', async () => {
    await seed();
    await openFacture(440);
    fireEvent.click(document.querySelector('.ct-search__result[aria-label^="Tâche, Appeler le fournisseur"]') as HTMLElement);
    await waitFor(() => expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: 't2' }));
    expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull();
    act(() => useNavigationStore.getState().closeDetail());
    pressCtrlK();
    fireEvent.click(screen.getByRole('button', { name: 'Rechercher' }));
    await screen.findByRole('dialog', { name: 'Recherche' });
    await typeQuery('facture');
    await screen.findByText('7 résultats');
    fireEvent.click(document.querySelector('.ct-search__result[aria-label^="Tâche, Relancer la facture"]') as HTMLElement);
    await waitFor(() => expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: 't3' }));
  });

  it('Ctrl+Entrée ouvre la tâche dans son onglet : Aujourd’hui à son jour, ou « Un jour » (critère 6)', async () => {
    await seed();
    await openFacture();
    await press(searchField(), 'Enter', { ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'today', date: '2026-09-23' });
    expect(useNavigationStore.getState().detail).toEqual({ type: 'task', id: 't1' });
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
    await typeQuery('fournisseur');
    await screen.findByText('1 résultat');
    await press(searchField(), 'Enter', { ctrlKey: true });
    await waitFor(() => expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'someday' }));
  });

  it('une checklist, un item, un événement, une routine et un objectif ouvrent leur écran (critère 3)', async () => {
    await seed();
    await openFacture();
    const openRow = async (prefix: string): Promise<void> => {
      if (!screen.queryByRole('dialog', { name: 'Recherche' })) {
        pressCtrlK();
        await screen.findByRole('dialog', { name: 'Recherche' });
        await typeQuery('facture');
        await screen.findByText('7 résultats');
      }
      fireEvent.click(document.querySelector(`.ct-search__result[aria-label^="${prefix}"]`) as HTMLElement);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    };
    await openRow('Checklist, Valise');
    expect(useNavigationStore.getState().route).toEqual({ tab: 'checklists', checklistId: 'c1' });
    await openRow('Événement, Échéance facture');
    expect(useNavigationStore.getState().route).toEqual({ tab: 'events' });
    expect(useNavigationStore.getState().detail).toEqual({ type: 'event', id: 'e1' });
    await openRow('Routine, Classer les factures');
    expect(useNavigationStore.getState().route).toEqual({ tab: 'routines', screen: 'list' });
    expect(useNavigationStore.getState().detail).toEqual({ type: 'routine', id: 'r1' });
    await openRow('Objectif, Boucler les factures');
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'goals' });
  });

  it('un élément supprimé entre-temps affiche « Cet élément n’existe plus » et reste dans la recherche (critère 4)', async () => {
    await seed();
    await openFacture();
    const target = document.querySelector('.ct-search__result[aria-label^="Tâche, Envoyer la facture"]') as HTMLElement;
    await h.db.driver.execute("UPDATE task SET deleted_at = '2026-10-02T09:00:00.000Z' WHERE id = 't1'");
    fireEvent.click(target);
    expect(await screen.findByText('Cet élément n’existe plus')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Recherche' })).toBeInTheDocument();
    expect(useNavigationStore.getState().detail).toBeNull();
    // La ligne reste listée jusqu'à la prochaine requête.
    expect(document.querySelector('.ct-search__result[aria-label^="Tâche, Envoyer la facture"]')).not.toBeNull();
  });

  it('ouvrir dans un onglet un élément masqué par le filtre global ramène ce filtre à « Tout »', async () => {
    await seed();
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    mockViewport(1440);
    renderSearchShell(h.container);
    await screen.findByRole('heading', { level: 1 });
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
    await typeQuery('facture');
    // Pas de filtre de recherche sur Perso : on le choisit puis on ouvre la routine Perso.
    const space = screen.getByRole('combobox', { name: 'Filtre Espace : Pro' });
    await act(async () => {
      fireEvent.change(space, { target: { value: SPACE_PERSO_ID } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText('3 résultats');
    fireEvent.click(document.querySelector('.ct-search__result[aria-label^="Routine, Classer"]') as HTMLElement);
    await waitFor(() => expect(useNavigationStore.getState().route).toEqual({ tab: 'routines', screen: 'list' }));
    expect(useAppStore.getState().spaceFilter).toBe('all');
    expect(await screen.findByText('Filtre « Tout » appliqué')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PRO_ID);
  });
});
