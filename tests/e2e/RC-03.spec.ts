import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertChecklists } from './helpers/checklists';
import { insertEvents } from './helpers/events';
import { goalScreen, insertGoals } from './helpers/goals';
import { insertRoutines, openRoutines } from './helpers/routines';
import { addIsoDays, browserToday } from './helpers/schedule';
import { insertSearchTasks, openSearch, resultRows, searchDialog, searchInput, typeSearch } from './helpers/search';
import { detailOf } from './helpers/spaces';
import { isPhone } from './helpers/today';
import { mondayOf } from './helpers/week';

/**
 * RC-03 — J'ouvre un résultat. Exécuté sur `pc` (clavier) et `iphone` (toucher).
 * Couverture : navigation ↑ / ↓ et Entrée (1, 2), fiche par-dessus l'onglet courant et retour (2), checklist, événement, routine,
 * objectif (3), « Un jour » et terminée (4), élément supprimé entre-temps (4), Ctrl+Entrée dans l'onglet (6), noms accessibles (7).
 */
test.describe('RC-03 — ouvrir un résultat', () => {
  async function seed(page: Page): Promise<string> {
    await openApp(page);
    const today = await browserToday(page);
    await insertSearchTasks(page, [
      { title: 'Envoyer la facture', note: 'à poster', space: 'pro', date: addIsoDays(today, 2) },
      { title: 'Appeler le fournisseur', note: 'contester la facture', space: 'perso', date: null, someday: true },
      { title: 'Relancer la facture d’août', space: 'pro', date: addIsoDays(today, -20), done: true },
    ]);
    await insertChecklists(page, [{ title: 'Valise', space: 'pro', items: ['Facture de l’hôtel'] }]);
    await insertEvents(page, [{ title: 'Échéance facture', date: addIsoDays(today, 9), space: 'perso' }]);
    await insertRoutines(page, [{ title: 'Classer les factures', space: 'perso' }]);
    await insertGoals(page, [{ title: 'Boucler les factures', weekStart: mondayOf(today), space: 'pro' }]);
    return today;
  }

  /** Ligne de résultat dont le nom accessible commence par `prefix` (« Tâche, Envoyer la facture »). */
  const row = (page: Page, prefix: string) => searchDialog(page).locator(`.ct-search__result[aria-label^="${prefix}"]`).first();

  async function search(page: Page, testInfo: { project: { name: string } }): Promise<void> {
    await openSearch(page, testInfo);
    await typeSearch(page, 'facture');
    await expect(searchDialog(page).getByText('7 résultats')).toBeVisible();
  }

  test('chaque ligne a un nom complet et une cible d’au moins 44 pt (critère 7)', async ({ page }, testInfo) => {
    await seed(page);
    await search(page, testInfo);
    const target = row(page, 'Tâche, Envoyer la facture');
    await expect(target).toHaveAttribute('aria-label', new RegExp(`^Tâche, Envoyer la facture, .+, Pro, à faire$`));
    for (const handle of await resultRows(page).all()) {
      const box = await handle.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
  });

  test('↑ / ↓ déplacent la sélection à travers les groupes, Entrée ouvre la fiche par-dessus l’onglet courant (critères 1, 2 et 5)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'navigation au clavier : PC');
    await seed(page);
    await openRoutines(page);
    await search(page, testInfo);
    const selected = searchDialog(page).locator('.ct-search__result[data-selected="true"]');
    await expect(selected).toHaveAttribute('aria-label', /^Tâche,/);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(searchInput(page)).toBeFocused();
    await expect(searchInput(page)).toHaveAttribute('aria-activedescendant', /ct-search-row-task-/);
    await page.keyboard.press('Control+End');
    await expect(selected).toHaveAttribute('aria-label', /^Objectif,/);
    await page.keyboard.press('Control+Home');
    await expect(selected).toHaveAttribute('aria-label', /^Tâche,/);
    // Entrée sur la première tâche : la recherche se ferme, la fiche s'ouvre par-dessus les Routines, qui restent l'onglet courant.
    await page.keyboard.press('Enter');
    await expect(searchDialog(page)).toHaveCount(0);
    await expect(detailOf(page)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detailOf(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  });

  test('toucher une tâche ouvre sa fiche (feuille sur iPhone, panneau sur PC), « Un jour » et terminée aussi (critères 2 et 4)', async ({ page }, testInfo) => {
    await seed(page);
    await search(page, testInfo);
    await row(page, 'Tâche, Appeler le fournisseur').click();
    await expect(searchDialog(page)).toHaveCount(0);
    await expect(detailOf(page)).toBeVisible();
    await expect(detailOf(page)).toContainText('Appeler le fournisseur');
    await page.keyboard.press('Escape');
    if (isPhone(testInfo)) await page.keyboard.press('Escape');
    await search(page, testInfo);
    await row(page, 'Tâche, Relancer la facture').click();
    await expect(detailOf(page)).toContainText('Relancer la facture d’août');
  });

  test('une checklist (et son item), un événement, une routine et un objectif ouvrent leur écran (critère 3)', async ({ page }, testInfo) => {
    await seed(page);
    await search(page, testInfo);
    await row(page, 'Checklist, Valise').click();
    await expect(searchDialog(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Valise' }).first()).toBeVisible();

    // Les écrans suivants s'ouvrent depuis Aujourd'hui (la loupe n'existe que là sur iPhone).
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await search(page, testInfo);
    await row(page, 'Événement, Échéance facture').click();
    await expect(page.getByRole('complementary', { name: 'Modifier l’événement' }).or(page.getByRole('dialog', { name: 'Modifier l’événement' }))).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await search(page, testInfo);
    await row(page, 'Routine, Classer les factures').click();
    await expect(page.getByRole('complementary', { name: 'Rapport de la routine' }).or(page.getByRole('dialog', { name: 'Rapport de la routine' }))).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await search(page, testInfo);
    await row(page, 'Objectif, Boucler les factures').click();
    await expect(goalScreen(page)).toBeVisible();
  });

  test('un élément supprimé entre-temps affiche « Cet élément n’existe plus » et reste dans la recherche (critère 4)', async ({ page }, testInfo) => {
    await seed(page);
    await search(page, testInfo);
    await page.evaluate(() => window.__ctTest?.execute("UPDATE task SET deleted_at = '2026-09-30T08:00:00.000Z' WHERE title = 'Envoyer la facture'"));
    await row(page, 'Tâche, Envoyer la facture').click();
    await expect(searchDialog(page).getByText('Cet élément n’existe plus')).toBeVisible();
    await expect(searchDialog(page)).toBeVisible();
    await expect(detailOf(page)).toHaveCount(0);
  });

  test('Ctrl+Entrée ouvre la tâche dans son onglet, à son jour (critère 6)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Ctrl+Entrée : PC');
    await seed(page);
    await openRoutines(page);
    await openSearch(page, testInfo);
    await typeSearch(page, 'poster');
    await expect(searchDialog(page).getByText('1 résultat', { exact: true })).toBeVisible();
    await page.keyboard.press('Control+Enter');
    await expect(searchDialog(page)).toHaveCount(0);
    // Aujourd'hui (onglet Tâches) affiche le jour de la tâche, avec sa fiche.
    await expect(page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(detailOf(page)).toContainText('Envoyer la facture');
  });
});
