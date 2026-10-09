import { expect, test, type Page } from '@playwright/test';
import { expectFitsViewport } from './helpers/layout';
import { isPhone, openToday } from './helpers/today';

/**
 * Test négatif de `expectFitsViewport` (revue de la PR #19) : le contrôle doit échouer pour un vrai débordement, dans la coquille de l'app
 * comme dans une feuille (deux conteneurs qui rognent leur contenu), et laisser passer la seule rangée défilante désignée (`data-scroll-row`).
 */
test.describe('expectFitsViewport : le contrôle de mise en page contrôle vraiment', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Mesure à 440 × 956.');
    await openToday(page);
  });

  const inject = (page: Page, selector: string): Promise<void> =>
    page.evaluate((target) => {
      const host = document.querySelector(target);
      if (!host) throw new Error(`conteneur ${target} introuvable`);
      const wide = document.createElement('div');
      wide.id = 'ct-test-wide';
      wide.textContent = 'trop large';
      wide.style.cssText = 'width:600px;min-width:600px;flex:none;height:20px;';
      host.appendChild(wide);
    }, selector);

  test('un élément de 600 px dans la coquille fait échouer le contrôle', async ({ page }) => {
    await inject(page, '.ct-app-shell');
    await expect(expectFitsViewport(page, 'coquille')).rejects.toThrow(/ct-test-wide|hors de la largeur|défilement horizontal/);
  });

  test('un élément de 600 px dans une feuille fait échouer le contrôle', async ({ page }) => {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' })).toBeVisible();
    await inject(page, '.ct-sheet');
    await expect(expectFitsViewport(page, 'feuille')).rejects.toThrow(/hors de la largeur|défilement horizontal/);
  });

  test('la rangée d’icônes désignée défile sans faire échouer le contrôle, mais seulement si elle tient elle-même dans la fenêtre', async ({ page }) => {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).tap();
    await expect(page.locator('.ct-icon-picker')).toBeVisible();
    await expectFitsViewport(page, 'feuille avec la rangée d’icônes');
    await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>('.ct-icon-picker');
      if (row) row.style.width = '700px';
    });
    await expect(expectFitsViewport(page, 'rangée trop large')).rejects.toThrow(/hors de la largeur|défilement horizontal/);
  });
});
