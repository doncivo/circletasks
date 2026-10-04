import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, pressCtrlK, renderSearchShell, searchField, setupSearch, teardownSearch, typeQuery, insertTask, SPACE_PERSO_ID, SPACE_PRO_ID, type SearchHarness } from './testKit';

const STAMP = `'2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', 'd', 'h'`;

describe('Recherche (RC-01)', () => {
  let h: SearchHarness;
  beforeEach(async () => {
    h = await setupSearch('501');
  });
  afterEach(() => teardownSearch(h));

  async function seedDemo(): Promise<void> {
    await insertTask(h, { id: 't1', title: 'Envoyer la facture', space: SPACE_PRO_ID, date: '2026-09-23' });
    await insertTask(h, { id: 't2', title: 'Relancer la facture d’août', space: SPACE_PRO_ID, date: '2026-09-03', status: 'done' });
    await insertTask(h, { id: 't3', title: 'Appeler le fournisseur d’énergie', note: 'contester la facture', space: SPACE_PERSO_ID, date: null, someday: true });
    await h.db.driver.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c1', '${SPACE_PRO_ID}', 'Factures fournisseurs', ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Relevé bancaire', 1, 1, ${STAMP})`);
    await h.db.driver.execute(`INSERT INTO event (id, space_id, title, start_date, end_date, repeat, created_at, updated_at, device_id, hlc) VALUES ('e1', '${SPACE_PERSO_ID}', 'Échéance facture électricité', '2026-10-10', '2026-10-10', 'monthly', ${STAMP})`);
  }

  async function openSearch(): Promise<void> {
    mockViewport(1440);
    renderSearchShell(h.container);
    await screen.findByRole('heading', { level: 1 });
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
  }

  it('Ctrl+K ouvre la palette depuis un champ de saisie, le champ est focalisé ; Échap ferme et rend le focus (critère 1)', async () => {
    mockViewport(1440);
    renderSearchShell(h.container);
    const addField = await screen.findByRole('textbox', { name: /nouvelle tâche|ajouter/i });
    addField.focus();
    pressCtrlK(addField);
    const dialog = await screen.findByRole('dialog', { name: 'Recherche' });
    expect(dialog).toHaveAttribute('data-layout', 'pc');
    expect(searchField()).toHaveFocus();
    fireEvent.keyDown(searchField(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    expect(addField).toHaveFocus();
    expect(useNavigationStore.getState().overlays).toEqual([]);
  });

  it('un second Ctrl+K ne l’ouvre pas deux fois', async () => {
    await openSearch();
    pressCtrlK(searchField());
    expect(screen.getAllByRole('dialog', { name: 'Recherche' })).toHaveLength(1);
    expect(useNavigationStore.getState().overlays).toHaveLength(1);
  });

  it('iPhone : la loupe de l’en-tête ouvre l’écran plein, « Annuler » revient (critère 2)', async () => {
    mockViewport(440);
    renderSearchShell(h.container);
    const loupe = await screen.findByRole('button', { name: 'Rechercher' });
    loupe.focus();
    fireEvent.click(loupe);
    const dialog = await screen.findByRole('dialog', { name: 'Recherche' });
    expect(dialog).toHaveAttribute('data-layout', 'mobile');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    expect(loupe).toHaveFocus();
  });

  it('PC : le champ « Rechercher Ctrl K » de l’en-tête ouvre la palette', async () => {
    mockViewport(1440);
    renderSearchShell(h.container);
    const field = await screen.findByRole('button', { name: 'Rechercher' });
    expect(field).toHaveTextContent('Ctrl K');
    fireEvent.click(field);
    await screen.findByRole('dialog', { name: 'Recherche' });
  });

  it('trouve « Envoyer la facture » par « facture », « FACTURE », « factüre » et « fact » (critère 3)', async () => {
    await seedDemo();
    await openSearch();
    for (const text of ['facture', 'FACTURE', 'factüre', 'fact']) {
      await typeQuery(text);
      expect(await screen.findByText('Envoyer la', { exact: false }), text).toBeInTheDocument();
      expect(screen.getAllByRole('heading', { level: 2 })[0], text).toHaveTextContent('Tâches · 3');
    }
  });

  it('groupe les résultats, surligne le mot, cite la note et l’item, annonce le nombre (critères 5 et 10)', async () => {
    await seedDemo();
    await insertTask(h, { id: 't9', title: 'Valise', note: '', space: SPACE_PRO_ID });
    await h.db.driver.execute(`INSERT INTO checklist_item (id, checklist_id, text, sort_order, created_at, updated_at, device_id, hlc) VALUES ('i2', 'c1', 'Facture de mars', 2, ${STAMP})`);
    await openSearch();
    await typeQuery('facture');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Tâches · 3', 'Checklists · 1', 'Événements · 1']);
    expect(screen.getByText('5 résultats')).toBeInTheDocument();
    expect(document.querySelector('.ct-search__count')).toHaveAttribute('aria-live', 'polite');
    const marks = Array.from(document.querySelectorAll('mark.ct-search__hl')).map((mark) => mark.textContent);
    expect(marks).toContain('facture');
    expect(marks).toContain('Factures');
    // Note citée, mot surligné, espace et « Un jour » sur la sous-ligne.
    const noteRow = screen.getByText('Appeler le fournisseur d’énergie').closest('.ct-search__result') as HTMLElement;
    expect(noteRow).toHaveTextContent('Note : « contester la facture »');
    expect(noteRow).toHaveTextContent('Un jour');
    expect(noteRow).toHaveTextContent('Perso');
    expect(within(noteRow).getByText('facture').tagName).toBe('MARK');
    // Item de checklist trouvé : la checklist est nommée, l'item cité.
    const listRow = screen.getByText('fournisseurs', { exact: false }).closest('.ct-search__result') as HTMLElement;
    expect(listRow).toHaveTextContent('Factures fournisseurs');
    expect(listRow).toHaveTextContent('Item : « Facture de mars »');
    expect(listRow).toHaveTextContent('1/2');
    // Tâche terminée et événement mensuel.
    const doneRow = screen.getByText('Relancer la', { exact: false }).closest('.ct-search__result') as HTMLElement;
    expect(doneRow).toHaveTextContent('fait');
    const eventRow = screen.getByText('Échéance', { exact: false }).closest('.ct-search__result') as HTMLElement;
    expect(eventRow).toHaveTextContent('Mensuel');
    expect(eventRow).toHaveTextContent('Perso');
  });

  it('exige 2 caractères et dit quand rien n’est trouvé (critère 6)', async () => {
    await seedDemo();
    await openSearch();
    await typeQuery('f');
    expect(screen.getByText('Tapez au moins 2 caractères')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
    await typeQuery('xyz');
    expect(await screen.findByText('Aucun résultat pour « xyz »')).toBeInTheDocument();
    await typeQuery('');
    expect(document.querySelector('.ct-search__count')).toHaveTextContent('');
  });

  it('limite à 100 résultats et invite à affiner (critère 8)', async () => {
    await h.db.driver.transaction(async (tx) => {
      for (let i = 0; i < 130; i += 1) {
        await tx.execute(`INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ${STAMP})`, [`b${String(i)}`, SPACE_PRO_ID, `Facture numéro ${String(i)}`]);
      }
    });
    await openSearch();
    await typeQuery('facture');
    expect(await screen.findByText('100 résultats')).toBeInTheDocument();
    expect(screen.getByText('Affinez la recherche')).toBeInTheDocument();
    expect(document.querySelectorAll('.ct-search__result')).toHaveLength(100);
  });

  it('exclut les éléments supprimés ; une tâche créée ou renommée est trouvée sans redémarrer (critères 4 et 9)', async () => {
    await seedDemo();
    await openSearch();
    await typeQuery('facture');
    expect(screen.getByText('Tâches · 3')).toBeInTheDocument();
    await act(async () => {
      await h.db.driver.execute("UPDATE task SET deleted_at = '2026-10-02T08:00:00.000Z' WHERE id = 't2'");
      await h.db.driver.execute("UPDATE task SET title = 'Payer le loyer' WHERE id = 't1'");
      await h.db.driver.execute(`INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('t7', '${SPACE_PRO_ID}', 'Facture garage', ${STAMP})`);
    });
    await typeQuery('factur');
    expect(await screen.findByText('Tâches · 2')).toBeInTheDocument();
    expect(screen.queryByText('Relancer la', { exact: false })).toBeNull();
    expect(screen.queryByText('Envoyer la', { exact: false })).toBeNull();
    await typeQuery('loyer');
    expect((await screen.findByText('loyer')).tagName).toBe('MARK');
  });

  it('reconstruit seul un index absent ou périmé à l’ouverture (critère 9)', async () => {
    await seedDemo();
    await h.db.driver.execute('DELETE FROM search_index');
    await h.db.driver.execute('DELETE FROM search_index_doc');
    await openSearch();
    await waitFor(async () => expect(await h.container.data.repos.search.isStale()).toBe(false));
    await typeQuery('facture');
    expect(await screen.findByText('Tâches · 3')).toBeInTheDocument();
  });

  it('reprend le filtre d’espace global par défaut, sans le modifier (critère 10)', async () => {
    await seedDemo();
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    await openSearch();
    await typeQuery('facture');
    expect(await screen.findByText('Tâches · 2')).toBeInTheDocument();
    expect(screen.getByText('Checklists · 1')).toBeInTheDocument();
    expect(screen.queryByText('Événements · 1')).toBeNull();
    expect(screen.getByText('3 résultats')).toBeInTheDocument();
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PRO_ID);
  });

  it('à la réouverture la recherche repart vide', async () => {
    await seedDemo();
    await openSearch();
    await typeQuery('facture');
    fireEvent.keyDown(searchField(), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
    expect(searchField()).toHaveValue('');
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
  });
});
