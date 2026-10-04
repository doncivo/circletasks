import { expect, test } from '@playwright/test';
import { isPhone, openToday, rowOf } from './helpers/today';

/**
 * Q-03 — dictée d'une tâche. PC : la dictée Windows (Win + H) saisit dans le champ, l'app apporte l'aide et la relecture (Playwright ne
 * peut pas lancer Win + H : le texte est saisi dans le champ comme le fait Windows). iPhone : le micro du clavier iOS suffit, aucun
 * bouton propre à l'app tant que le plugin Speech n'existe pas (ordre 5).
 */
test.describe('Q-03 — dictée', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('PC : micro « Dicter », aide Win + H, relecture avant d’ajouter, heure dictée en lettres lue', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Dictée Windows : PC seulement');
    const mic = page.getByRole('button', { name: 'Dicter' });
    const field = page.getByLabel('Nouvelle tâche');
    await expect(mic).toBeVisible();
    const box = await mic.boundingBox();
    expect(box?.width).toBe(44);
    expect(box?.height).toBe(44);
    await mic.click();
    await expect(field).toBeFocused();
    await expect(page.getByText('Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter')).toBeVisible();
    await expect(field).toHaveAccessibleDescription('Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter');
    // Windows saisit le texte dicté dans le champ : rien n'est envoyé seul.
    await page.keyboard.insertText('appeler le notaire demain dix heures');
    await expect(page.getByRole('group', { name: 'Ce qui sera appliqué' })).toContainText('demain · 10:00');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-today__list .ct-list-row')).toHaveCount(0);
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    const row = rowOf(page, 'appeler le notaire');
    await expect(row).toBeVisible();
    await expect(row.locator('.ct-list-row__subtitle, .ct-list-row__meta')).toContainText('10:00');
  });

  test('PC : le micro est atteignable au clavier juste après le champ', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'PC seulement');
    await page.getByLabel('Nouvelle tâche').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Dicter' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Nouvelle tâche')).toBeFocused();
  });

  test('iPhone : aucun bouton micro propre à l’app (clavier iOS), ni sur Aujourd’hui ni dans la feuille', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'iPhone seulement');
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: 'Dicter' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dicter' })).toHaveCount(0);
  });
});
