import { expect, test, type Page } from '@playwright/test';
import { addIsoDays } from './helpers/schedule';
import { isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, dayTitles, openWeek, taskButton, weekTab } from './helpers/week';

/**
 * S-04 — Je crée une tâche directement dans un jour.
 *
 * Couverture : « + Ajouter » en bas de chaque jour (1), champ focalisé libellé (2), Entrée crée la tâche du jour et laisse le
 * champ ouvert et vide (3), Échap et champ vide sans effet (4), espace du filtre actif (3), jour passé permis (6), champ visible
 * sur iPhone (7), cinq tâches sans quitter l'écran, chacune visible en moins de 500 ms (8). Exécuté sur `pc` et `iphone`.
 */

const addButton = (page: Page, iso: string) => dayOf(page, iso).getByRole('button', { name: /^Ajouter une tâche,/ });
const field = (page: Page, iso: string) => dayOf(page, iso).getByRole('combobox');

async function typeAndEnter(page: Page, iso: string, title: string): Promise<void> {
  await field(page, iso).fill(title);
  await field(page, iso).press('Enter');
}

test.describe('S-04 — ajout rapide dans un jour', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
    await openWeek(page);
  });

  test('chaque jour présente « + Ajouter » en bas, vide ou non (critère 1)', async ({ page }) => {
    const monday = await browserMonday(page);
    await expect(page.locator('.ct-week__days').getByRole('button', { name: /^Ajouter une tâche,/ })).toHaveCount(7);
    for (let i = 0; i < 7; i += 1) {
      await expect(addButton(page, addIsoDays(monday, i))).toHaveText('+ Ajouter');
    }
  });

  test('un clic ouvre un champ focalisé ; Entrée crée la tâche du jour sans heure, le champ reste ouvert et vide (critères 2, 3)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    const thursday = addIsoDays(monday, 3);
    const title = `Réunion d’équipe ${testInfo.project.name}`;
    await addButton(page, thursday).click();
    const input = field(page, thursday);
    await expect(input).toBeFocused();
    await expect(input).toHaveAccessibleName(/^Nouvelle tâche pour (jeu\.) \d+$/);

    await typeAndEnter(page, thursday, title);
    await expect(taskButton(page, title)).toBeVisible();
    await expect.poll(() => dayTitles(page, thursday)).toEqual([title]);
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    // Sans heure : ni heure ni espace dans la ligne iPhone ; la carte PC n'affiche que l'espace.
    await expect(dayOf(page, thursday).locator('.ct-week-item__time')).toHaveCount(0);

    // Une tâche de plus à la suite, sans rouvrir le champ.
    await typeAndEnter(page, thursday, `${title} bis`);
    await expect.poll(() => dayTitles(page, thursday)).toEqual([title, `${title} bis`]);

    // Enregistrée : elle survit au changement d'onglet.
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await weekTab(page).click();
    await expect.poll(() => dayTitles(page, thursday)).toEqual([title, `${title} bis`]);
  });

  test('Échap referme le champ sans rien créer ; un champ vide ou d’espaces ne crée rien (critère 4)', async ({ page }) => {
    const monday = await browserMonday(page);
    const tuesday = addIsoDays(monday, 1);
    await addButton(page, tuesday).click();
    await field(page, tuesday).fill('Abandonnée');
    await field(page, tuesday).press('Escape');
    await expect(field(page, tuesday)).toHaveCount(0);
    await expect(addButton(page, tuesday)).toBeFocused();
    await expect.poll(() => dayTitles(page, tuesday)).toEqual([]);

    await addButton(page, tuesday).click();
    await typeAndEnter(page, tuesday, '    ');
    await expect(field(page, tuesday)).toBeVisible();
    await expect.poll(() => dayTitles(page, tuesday)).toEqual([]);

    // Quitter le champ vide (clic ailleurs) le referme.
    await page.getByRole('heading', { level: 1 }).click();
    await expect(field(page, tuesday)).toHaveCount(0);
  });

  test('la tâche est créée dans l’espace du filtre actif (critère 3) et l’ajout est permis sur un jour passé (critère 6)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    const title = `Perso lundi ${testInfo.project.name}`;
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    await addButton(page, monday).click();
    await field(page, monday).fill(title);
    // « lundi » est lu comme une date (Q-02) : on retire la pastille pour garder le titre.
    await page.getByRole('button', { name: /^Retirer/ }).click();
    await field(page, monday).press('Enter');
    await expect(taskButton(page, title)).toBeVisible();
    await page.getByRole('button', { name: 'Pro', exact: true }).click();
    await expect(taskButton(page, title)).toHaveCount(0);
    await page.getByRole('button', { name: 'Tout', exact: true }).click();
    await expect(taskButton(page, title)).toBeVisible();
    if (!isPhone(testInfo)) await expect(taskButton(page, title).locator('xpath=ancestor::*[contains(@class,"ct-week-item")][1]')).toContainText('Perso');
  });

  test('cinq tâches réparties sur la semaine se créent sans quitter l’écran, chacune visible en moins de 500 ms (critère 8)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    const plan = [0, 1, 2, 4, 6].map((offset) => ({ iso: addIsoDays(monday, offset), title: `Tâche ${String(offset + 1)} ${testInfo.project.name}` }));
    for (const { iso, title } of plan) {
      await addButton(page, iso).click();
      await field(page, iso).fill(title);
      await field(page, iso).press('Enter');
      await expect(taskButton(page, title)).toBeVisible({ timeout: 500 });
    }
    for (const { iso, title } of plan) expect(await dayTitles(page, iso)).toEqual([title]);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('iPhone : le champ du dernier jour reste visible à l’écran (critère 7)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Défilement au-dessus du clavier : iPhone.');
    const sunday = addIsoDays(await browserMonday(page), 6);
    await addButton(page, sunday).click();
    await expect(field(page, sunday)).toBeInViewport({ ratio: 1 });
    await typeAndEnter(page, sunday, 'Dimanche soir');
    await expect(field(page, sunday)).toBeInViewport({ ratio: 1 });
  });
});
