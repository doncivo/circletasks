import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSharedSetting } from '../../domain/model';
import { mockViewport, pressCtrlK, renderSearchShell, searchField, setupSearch, teardownSearch, typeQuery, insertTask, type SearchHarness } from './testKit';

describe('Recherches récentes (RC-04)', () => {
  let h: SearchHarness;
  beforeEach(async () => {
    h = await setupSearch('504');
  });
  afterEach(() => teardownSearch(h));

  const stored = (): Promise<readonly string[]> => h.container.data.repos.settings.get('search.recent');
  const chips = (): string[] => Array.from(document.querySelectorAll('.ct-search__recentPick')).map((chip) => chip.textContent ?? '');

  async function openSearch(): Promise<void> {
    mockViewport(1440);
    renderSearchShell(h.container);
    await screen.findByRole('heading', { level: 1 });
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
  }

  async function validate(text: string): Promise<void> {
    await typeQuery(text);
    await act(async () => {
      fireEvent.keyDown(searchField(), { key: 'Enter' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  /** Ferme la recherche (Échap) si elle est ouverte — Entrée sur un résultat l'a peut-être déjà fermée —, puis la rouvre par Ctrl+K. */
  async function reopen(): Promise<void> {
    if (screen.queryByRole('dialog', { name: 'Recherche' })) {
      fireEvent.keyDown(searchField(), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Recherche' })).toBeNull());
    }
    pressCtrlK();
    await screen.findByRole('dialog', { name: 'Recherche' });
  }

  it('sans historique, la section est absente (critère 1)', async () => {
    await openSearch();
    expect(screen.queryByText('Recherches récentes')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Effacer les recherches récentes' })).toBeNull();
  });

  it('Entrée avec 2 caractères au moins enregistre ; une frappe seule ne l’enregistre pas (critère 3)', async () => {
    await openSearch();
    await typeQuery('notaire');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(await stored()).toEqual([]);
    await validate('notaire');
    expect(await stored()).toEqual(['notaire']);
    await validate('a');
    expect(await stored()).toEqual(['notaire']);
  });

  it('ouvrir un résultat enregistre la recherche (critère 3)', async () => {
    await insertTask(h, { id: 't1', title: 'Envoyer la facture' });
    await openSearch();
    await typeQuery('facture');
    const row = await waitFor(() => {
      const found = document.querySelector('.ct-search__result');
      if (!found) throw new Error('pas de résultat');
      return found as HTMLElement;
    });
    fireEvent.click(row);
    await waitFor(async () => expect(await stored()).toEqual(['facture']));
  });

  it('champ vide : puces de la plus récente à la plus ancienne ; toucher une puce remplit le champ et affiche les résultats (critères 1 et 2)', async () => {
    await openSearch();
    await validate('sport');
    await validate('passeport');
    await validate('notaire');
    await insertTask(h, { id: 't1', title: 'Rendez-vous chez le notaire' });
    await reopen();
    expect(screen.getByRole('heading', { name: 'Recherches récentes' })).toBeInTheDocument();
    expect(chips()).toEqual(['notaire', 'passeport', 'sport']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recherche récente : notaire' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(searchField()).toHaveValue('notaire');
    expect(await screen.findByText('1 résultat')).toBeInTheDocument();
    // La section disparaît dès que le champ n'est plus vide.
    expect(screen.queryByText('Recherches récentes')).toBeNull();
  });

  it('une requête déjà présente (casse et accents ignorés) remonte en tête sans doublon ; dix au plus (critère 4)', async () => {
    await openSearch();
    await validate('Clôture');
    await validate('sport');
    await validate('CLOTURE');
    expect(await stored()).toEqual(['CLOTURE', 'sport']);
    for (let i = 1; i <= 12; i += 1) await validate(`recherche ${String(i)}`);
    const list = await stored();
    expect(list).toHaveLength(10);
    expect(list[0]).toBe('recherche 12');
    expect(list).not.toContain('sport');
  });

  it('la croix d’une puce la retire ; le nom accessible est « Recherche récente : notaire, supprimer » (critères 5 et 7)', async () => {
    await openSearch();
    await validate('notaire');
    await validate('sport');
    await reopen();
    expect(chips()).toEqual(['sport', 'notaire']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Recherche récente : notaire, supprimer' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(chips()).toEqual(['sport']);
    expect(await stored()).toEqual(['sport']);
  });

  it('Suppr sur une puce la retire et le focus passe à la puce voisine (critère 7)', async () => {
    await openSearch();
    await validate('notaire');
    await validate('sport');
    await validate('passeport');
    await reopen();
    const pick = screen.getByRole('button', { name: 'Recherche récente : sport' });
    pick.focus();
    await act(async () => {
      fireEvent.keyDown(pick, { key: 'Delete' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(chips()).toEqual(['passeport', 'notaire']);
    expect(await stored()).toEqual(['passeport', 'notaire']);
    expect(screen.getByRole('button', { name: 'Recherche récente : notaire' })).toHaveFocus();
  });

  it('« Effacer » vide la liste avec un message « Annuler » de 5 s qui la restitue (critère 5)', async () => {
    await openSearch();
    await validate('notaire');
    await validate('sport');
    await reopen();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Effacer les recherches récentes' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(await stored()).toEqual([]);
    expect(screen.queryByText('Recherches récentes')).toBeNull();
    expect(screen.getByText('Recherches récentes effacées')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(await stored()).toEqual(['sport', 'notaire']);
    await waitFor(() => expect(chips()).toEqual(['sport', 'notaire']));
  });

  it('l’historique survit à la fermeture, reste local à l’appareil et ne contient que du texte (critères 6 et 8)', async () => {
    await insertTask(h, { id: 't1', title: 'Facture' });
    await openSearch();
    await validate('facture');
    await reopen();
    expect(chips()).toEqual(['facture']);
    // Réglage local : jamais envoyé dans les journaux de synchro ni partagé ; aucune trace de filtre ni de résultat.
    expect(isSharedSetting('search.recent')).toBe(false);
    const rows = await h.db.driver.select<{ value: string }>("SELECT value FROM settings WHERE key = 'search.recent'");
    expect(JSON.parse(rows[0]?.value ?? 'null')).toEqual(['facture']);
    expect(within(screen.getByRole('dialog', { name: 'Recherche' })).queryByRole('alert')).toBeNull();
  });
});
