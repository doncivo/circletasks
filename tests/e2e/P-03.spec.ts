import { expect, test, type Page } from '@playwright/test';
import { openToday } from './helpers/today';

/**
 * P-03 — Je règle le premier jour de semaine, la langue et le format d'heure.
 *
 * Couverture : écran « Apparence et formats » depuis Réglages (ligne « Thème · semaine · heure »), Lundi / Samedi / Dimanche et 24 h / 12 h
 * en groupes radio (critères 1, 5, 11), langue en lecture seule (4), la Semaine commence le dimanche (2), valeur de la ligne de Réglages
 * mise à jour (9). Exécuté sur `pc` et `iphone`.
 */
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function openAppearance(page: Page): Promise<void> {
  await openToday(page);
  await tab(page, 'Réglages').click();
  await page.getByRole('button', { name: /^Thème · semaine · heure/ }).click();
  await expect(page.getByRole('heading', { name: 'Apparence et formats' })).toBeVisible();
}

test.describe('P-03 — premier jour, langue, format d’heure', () => {
  test('défauts : lundi et 24 h, langue Français non modifiable (critères 1, 4, 5)', async ({ page }) => {
    await openAppearance(page);
    await expect(page.getByRole('radiogroup', { name: 'Premier jour de la semaine' }).getByRole('radio', { name: 'Lundi' })).toBeChecked();
    await expect(page.getByRole('radiogroup', { name: 'Format de l’heure' }).getByRole('radio', { name: '24 h' })).toBeChecked();
    await expect(page.getByText('D’autres langues ne sont pas prévues')).toBeVisible();
    await expect(page.getByText('Exemple : 15:30')).toBeVisible();
  });

  test('choisir Dimanche et 12 h : la ligne de Réglages suit et la Semaine commence le dimanche (critères 2, 6, 9)', async ({ page }) => {
    await openAppearance(page);
    await page.getByRole('radio', { name: 'Dimanche' }).click();
    await page.getByRole('radio', { name: '12 h' }).click();
    await expect(page.getByText('Exemple : 3:30 PM')).toBeVisible();
    await page.getByRole('button', { name: 'Retour aux réglages' }).click();
    await expect(page.getByRole('button', { name: /Système · dimanche · 12 h/ })).toBeVisible();
    await tab(page, 'Semaine').click();
    const first = page.locator('.ct-week-day').first();
    await expect(first).toBeVisible();
    const date = await first.getAttribute('data-date');
    expect(new Date(`${date ?? ''}T00:00:00Z`).getUTCDay()).toBe(0);
  });
});
