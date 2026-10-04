import { expect, test, type Page } from '@playwright/test';
import { openToday } from './helpers/today';

/**
 * P-01 — Je réordonne et masque les onglets.
 *
 * Couverture : écran « Onglets » depuis Réglages (« 5 visibles »), Tâches fixe (critères 1, 5), Checklists remontée au clavier et la
 * colonne change aussitôt (2, 3), Événements masqué puis rétabli (4), raccourci d'un onglet masqué sans effet (6), « Rétablir l'ordre
 * par défaut » (8). Exécuté sur `pc` et `iphone`.
 */
const rail = (page: Page) => page.getByRole('navigation');
const tab = (page: Page, name: string) => rail(page).getByRole('button', { name, exact: true });
const railNames = (page: Page) => rail(page).getByRole('button').allTextContents();

async function openTabsScreen(page: Page): Promise<void> {
  await openToday(page);
  await tab(page, 'Réglages').click();
  await page.getByRole('button', { name: /^Onglets : / }).click();
  await expect(page.getByRole('heading', { name: 'Onglets' })).toBeVisible();
}

test.describe('P-01 — onglets', () => {
  test('cinq onglets listés, Tâches fixe et « Toujours affiché » (critères 1, 5)', async ({ page }) => {
    await openToday(page);
    await tab(page, 'Réglages').click();
    await expect(page.getByRole('button', { name: 'Onglets : 5 visibles' })).toBeVisible();
    await page.getByRole('button', { name: 'Onglets : 5 visibles' }).click();
    await expect(page.getByRole('listitem')).toHaveCount(5);
    await expect(page.getByRole('switch', { name: 'Afficher Tâches' })).toBeDisabled();
    await expect(page.getByText('Toujours affiché')).toBeVisible();
    await expect(page.getByText('Réglages reste toujours en bas.')).toBeVisible();
  });

  test('↑ sur la poignée de Checklists change aussitôt la colonne d’onglets (critères 2, 3)', async ({ page }) => {
    await openTabsScreen(page);
    expect(await railNames(page)).toEqual(['Tâches', 'Semaine', 'Routines', 'Événements', 'Checklists', 'Réglages']);
    const handle = page.getByRole('button', { name: 'Déplacer l’onglet Checklists' });
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => railNames(page)).toEqual(['Tâches', 'Semaine', 'Checklists', 'Routines', 'Événements', 'Réglages']);
  });

  test('Événements masqué disparaît de la colonne, rétabli il revient ; son raccourci ne répond plus masqué (critères 4, 6)', async ({ page }) => {
    await openTabsScreen(page);
    await page.getByRole('switch', { name: 'Afficher Événements' }).click();
    await expect(tab(page, 'Événements')).toHaveCount(0);
    await page.keyboard.press('Alt+4');
    await expect(page.getByRole('heading', { name: 'Onglets' })).toBeVisible();
    await page.getByRole('switch', { name: 'Afficher Événements' }).click();
    await expect(tab(page, 'Événements')).toBeVisible();
    await page.keyboard.press('Alt+4');
    await expect(tab(page, 'Événements')).toHaveAttribute('aria-current', 'page');
  });

  test('« Rétablir l’ordre par défaut » remet tout (critère 8)', async ({ page }) => {
    await openTabsScreen(page);
    await page.getByRole('switch', { name: 'Afficher Semaine' }).click();
    await expect(tab(page, 'Semaine')).toHaveCount(0);
    await page.getByRole('button', { name: 'Rétablir l’ordre par défaut' }).click();
    await expect(tab(page, 'Semaine')).toBeVisible();
    expect(await railNames(page)).toEqual(['Tâches', 'Semaine', 'Routines', 'Événements', 'Checklists', 'Réglages']);
  });
});
