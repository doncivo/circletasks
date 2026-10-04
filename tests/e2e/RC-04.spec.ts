import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { closeSearch, insertSearchTasks, openSearch, resultRows, searchDialog, searchInput, typeSearch } from './helpers/search';

/**
 * RC-04 — Je retrouve mes recherches récentes. Exécuté sur `pc` et `iphone`.
 * Couverture : section et ordre (1), toucher une puce (2), enregistrement à Entrée seulement (3), dix au plus et doublons (4), croix et
 * « Effacer » avec « Annuler » (5), noms accessibles et Suppr (7). La survie au redémarrage (6) est vérifiée en Vitest : la base du
 * navigateur de développement est en mémoire et vide à chaque chargement.
 */
test.describe('RC-04 — recherches récentes', () => {
  const recent = (page: Page) => searchDialog(page).locator('.ct-search__recentPick');

  /** Tape `text` puis Entrée : la recherche est enregistrée ; sans résultat, elle reste ouverte. */
  async function validate(page: Page, text: string): Promise<void> {
    await typeSearch(page, text);
    await expect(searchDialog(page).getByText(`Aucun résultat pour « ${text} »`)).toBeVisible();
    await searchInput(page).press('Enter');
  }

  async function seed(page: Page): Promise<void> {
    await openApp(page);
    await insertSearchTasks(page, [{ title: 'Rendez-vous chez le notaire', space: 'pro' }]);
  }

  test('sans historique la section est absente ; Entrée enregistre, une frappe seule non (critères 1 et 3)', async ({ page }, testInfo) => {
    await seed(page);
    await openSearch(page, testInfo);
    await expect(searchDialog(page).getByRole('heading', { name: 'Recherches récentes' })).toHaveCount(0);
    await typeSearch(page, 'sport');
    await expect(searchDialog(page).getByText('Aucun résultat pour « sport »')).toBeVisible();
    await closeSearch(page, testInfo);
    await openSearch(page, testInfo);
    await expect(searchDialog(page).getByRole('heading', { name: 'Recherches récentes' })).toHaveCount(0);
    await validate(page, 'sport');
    await typeSearch(page, '');
    await expect(recent(page)).toHaveText(['sport']);
  });

  test('de la plus récente à la plus ancienne ; toucher une puce remplit le champ et affiche les résultats (critères 1 et 2)', async ({ page }, testInfo) => {
    await seed(page);
    await openSearch(page, testInfo);
    for (const text of ['sport', 'passeport', 'clôture']) await validate(page, text);
    await typeSearch(page, 'notaire');
    await expect(resultRows(page)).toHaveCount(1);
    await resultRows(page).first().click();
    await expect(searchDialog(page)).toHaveCount(0);
    // La fiche de la tâche ouverte reste affichée : on la ferme avant de rouvrir la recherche.
    await page.keyboard.press('Escape');
    await openSearch(page, testInfo);
    await expect(recent(page)).toHaveText(['notaire', 'clôture', 'passeport', 'sport']);
    await searchDialog(page).getByRole('button', { name: 'Recherche récente : notaire', exact: true }).click();
    await expect(searchInput(page)).toHaveValue('notaire');
    await expect(resultRows(page)).toHaveCount(1);
  });

  test('une requête déjà présente remonte sans doublon ; dix au plus (critère 4)', async ({ page }, testInfo) => {
    await seed(page);
    await openSearch(page, testInfo);
    await validate(page, 'Clôture');
    await validate(page, 'sport');
    await validate(page, 'CLOTURE');
    await typeSearch(page, '');
    await expect(recent(page)).toHaveText(['CLOTURE', 'sport']);
    for (let i = 1; i <= 11; i += 1) await validate(page, `essai ${String(i)}`);
    await typeSearch(page, '');
    await expect(recent(page)).toHaveCount(10);
    await expect(recent(page).first()).toHaveText('essai 11');
    await expect(searchDialog(page).getByRole('button', { name: 'Recherche récente : sport', exact: true })).toHaveCount(0);
  });

  test('la croix retire une puce ; « Effacer » vide tout avec un message « Annuler » (critère 5)', async ({ page }, testInfo) => {
    await seed(page);
    await openSearch(page, testInfo);
    for (const text of ['sport', 'passeport']) await validate(page, text);
    await typeSearch(page, '');
    await searchDialog(page).getByRole('button', { name: 'Recherche récente : sport, supprimer', exact: true }).click();
    await expect(recent(page)).toHaveText(['passeport']);
    await validate(page, 'notaire2');
    await typeSearch(page, '');
    await expect(recent(page)).toHaveText(['notaire2', 'passeport']);
    await searchDialog(page).getByRole('button', { name: 'Effacer les recherches récentes' }).click();
    await expect(searchDialog(page).getByRole('heading', { name: 'Recherches récentes' })).toHaveCount(0);
    const toast = page.locator('.ct-undo-host');
    await expect(toast).toContainText('Recherches récentes effacées');
    await toast.getByRole('button', { name: 'Annuler' }).click();
    await expect(recent(page)).toHaveText(['notaire2', 'passeport']);
  });

  test('accessible : noms « Recherche récente : … » et Suppr retire la puce focalisée (critère 7)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone', 'clavier : PC');
    await seed(page);
    await openSearch(page, testInfo);
    for (const text of ['sport', 'passeport', 'clôture']) await validate(page, text);
    await typeSearch(page, '');
    const middle = searchDialog(page).getByRole('button', { name: 'Recherche récente : passeport', exact: true });
    await middle.focus();
    await page.keyboard.press('Delete');
    await expect(recent(page)).toHaveText(['clôture', 'sport']);
    await expect(searchDialog(page).getByRole('button', { name: 'Recherche récente : sport', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(searchInput(page)).toHaveValue('sport');
  });
});
