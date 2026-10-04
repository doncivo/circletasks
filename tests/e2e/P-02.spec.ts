import { expect, test, type Page } from '@playwright/test';
import { openToday } from './helpers/today';

/**
 * P-02 — Je choisis clair, sombre ou système.
 *
 * Couverture : trois choix en groupe radio, « Système » par défaut qui suit la préférence du système y compris à chaud (critères 1, 3),
 * « Sombre » appliqué aussitôt sur toute l'interface (2), annonce « Thème sombre activé » (9), mémorisation pour le script de premier affichage (4). Exécuté sur `pc` et `iphone`.
 */
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function openAppearance(page: Page): Promise<void> {
  await openToday(page);
  await tab(page, 'Réglages').click();
  await page.getByRole('button', { name: /^Thème · semaine · heure/ }).click();
  await expect(page.getByRole('heading', { name: 'Apparence et formats' })).toBeVisible();
}

test.describe('P-02 — thème', () => {
  test('« Système » suit la préférence du système, y compris quand elle change (critères 1, 3)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openAppearance(page);
    await expect(page.getByRole('radiogroup', { name: 'Thème de l’application' }).getByRole('radio', { name: 'Système' })).toBeChecked();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    const light = await background(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => background(page)).not.toBe(light);
  });

  test('« Sombre » change toute l’interface aussitôt et l’annonce ; « Clair » la rétablit (critères 2, 9)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openAppearance(page);
    const light = await background(page);
    await page.getByRole('radio', { name: 'Sombre' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('status')).toHaveText('Thème sombre activé');
    expect(await background(page)).not.toBe(light);
    await page.getByRole('radio', { name: 'Clair' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await background(page)).toBe(light);
  });

  test('le choix est mémorisé pour le script de premier affichage (critère 4)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openAppearance(page);
    await page.getByRole('radio', { name: 'Sombre' }).click();
    await expect.poll(() => page.evaluate(() => window.localStorage.getItem('ct.theme'))).toBe('dark');
    // Le script public/theme-init.js (testé en unitaire) pose data-theme avant React ; le serveur de développement le sert.
    const script = await page.request.get('/theme-init.js');
    expect(script.ok()).toBe(true);
    expect(await script.text()).toContain("getItem('ct.theme')");
  });
});
