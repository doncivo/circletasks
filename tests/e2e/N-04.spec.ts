import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { isPhone } from './helpers/today';

/**
 * N-04 — Je règle un récapitulatif matin et soir.
 *
 * Couverture : ligne « Récapitulatifs » (07:30 · 21:00 par défaut, QB-09), écran Matin / Soir avec interrupteur et heure 24 h,
 * enregistrement, refus d'un soir qui ne suit pas le matin (la persistance après redémarrage est vérifiée en Vitest : la base du navigateur de développement est en mémoire), mention « Envoyé sur l'iPhone » sur PC.
 * Le contenu des récapitulatifs est vérifié en Vitest. Aucun récapitulatif n'est émis (ordre 5, iPhone seulement).
 * Exécuté sur `pc` et `iphone`.
 */
test.describe('N-04 — récapitulatifs matin et soir', () => {
  async function openSettings(page: Page): Promise<void> {
    await openApp(page);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
  }
  const row = (page: Page) => page.getByRole('button', { name: /^Récapitulatifs :/ });

  test('valeurs par défaut, écran Matin / Soir, enregistrement (critères 1, 2, 3, 9)', async ({ page }, testInfo) => {
    await openSettings(page);
    await expect(page.getByText('RAPPELS', { exact: true })).toBeVisible();
    await expect(row(page)).toContainText('07:30 · 21:00');
    await row(page).click();
    await expect(page.getByRole('heading', { name: 'Récapitulatifs' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Récapitulatif du matin' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Récapitulatif du soir' })).toHaveAttribute('aria-checked', 'true');
    // Critère 7 : « Envoyé sur l'iPhone » sur PC seulement.
    if (isPhone(testInfo)) await expect(page.getByText('Envoyé sur l’iPhone')).toHaveCount(0);
    else await expect(page.getByText('Envoyé sur l’iPhone')).toBeVisible();

    await page.getByLabel('Heure du récapitulatif du matin (HH:MM)').fill('07:00');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page)).toContainText('07:00 · 21:00');

  });

  test('un soir qui ne suit pas le matin est refusé (critère 4)', async ({ page }) => {
    await openSettings(page);
    await row(page).click();
    await page.getByLabel('Heure du récapitulatif du matin (HH:MM)').fill('22:00');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('alert')).toHaveText('L’heure du soir doit suivre celle du matin');
  });

  test('désactiver les deux : « Désactivés » (critère 1)', async ({ page }) => {
    await openSettings(page);
    await row(page).click();
    await page.getByRole('switch', { name: 'Récapitulatif du matin' }).click();
    await page.getByRole('switch', { name: 'Récapitulatif du soir' }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page)).toContainText('Désactivés');
  });
});
