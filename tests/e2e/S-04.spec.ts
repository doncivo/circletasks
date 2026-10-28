import { expect, test, type Locator, type Page } from '@playwright/test';
import { addIsoDays } from './helpers/schedule';
import { isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, dayTitles, openWeek, taskButton, weekTab } from './helpers/week';

/**
 * S-04 — Je crée une tâche directement dans un jour.
 *
 * PC : « + Ajouter » en bas de chaque jour (1), champ focalisé libellé (2), Entrée crée la tâche du jour et laisse le champ ouvert et
 * vide (3), Échap et champ vide sans effet (4), espace du filtre actif (3), jour passé permis (6), cinq tâches sans quitter l'écran,
 * chacune visible en moins de 500 ms (8). iPhone (UI-REFONTE-03, Semaine-v2.html) : plus de bouton par jour ; une rangée d'ajout unique
 * en bas vise le jour choisi d'un toucher sur sa colonne de gauche (« Ajouter à jeudi 24 »), toujours visible au-dessus du clavier (7).
 * Exécuté sur `pc` et `iphone`.
 */

type Info = { project: { name: string } };

const addButton = (page: Page, iso: string) => dayOf(page, iso).getByRole('button', { name: /^Ajouter une tâche,/ });
const dayField = (page: Page, iso: string) => dayOf(page, iso).getByRole('combobox');
/** UI-REFONTE-03 : colonne de gauche d'un jour (iPhone), qui vise ce jour pour la rangée d'ajout. */
const dayHead = (page: Page, iso: string) => dayOf(page, iso).getByRole('button', { name: /^Choisir / });
const addRowField = (page: Page) => page.locator('.ct-week__addRow').getByRole('combobox', { name: 'Nouvelle tâche' });

/** Ouvre le champ d'ajout visant `iso` : bouton du jour (PC) ou toucher sur le jour, champ de la rangée (iPhone). */
async function openField(page: Page, iso: string, testInfo: Info): Promise<Locator> {
  if (isPhone(testInfo)) {
    await dayHead(page, iso).click();
    await expect(addRowField(page)).toHaveAttribute('placeholder', /^Ajouter à /);
    return addRowField(page);
  }
  await addButton(page, iso).click();
  return dayField(page, iso);
}

const fieldOf = (page: Page, iso: string, testInfo: Info): Locator => (isPhone(testInfo) ? addRowField(page) : dayField(page, iso));

async function typeAndEnter(page: Page, iso: string, title: string, testInfo: Info): Promise<void> {
  await fieldOf(page, iso, testInfo).fill(title);
  await fieldOf(page, iso, testInfo).press('Enter');
}

test.describe('S-04 — ajout rapide dans un jour', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
    await openWeek(page);
  });

  test('chaque jour présente « + Ajouter » en bas, vide ou non (critère 1) ; iPhone : une rangée d’ajout unique (UI-REFONTE-03)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    if (isPhone(testInfo)) {
      await expect(page.locator('.ct-week__days').getByRole('button', { name: /^Ajouter une tâche,/ })).toHaveCount(0);
      await expect(addRowField(page)).toBeVisible();
      await expect(addRowField(page)).toHaveAttribute('placeholder', /^Ajouter à /);
      return;
    }
    await expect(page.locator('.ct-week__days').getByRole('button', { name: /^Ajouter une tâche,/ })).toHaveCount(7);
    for (let i = 0; i < 7; i += 1) {
      await expect(addButton(page, addIsoDays(monday, i))).toHaveText('+ Ajouter');
    }
  });

  test('un clic ouvre un champ focalisé ; Entrée crée la tâche du jour sans heure, le champ reste ouvert et vide (critères 2, 3)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    const thursday = addIsoDays(monday, 3);
    const title = `Réunion d’équipe ${testInfo.project.name}`;
    const input = await openField(page, thursday, testInfo);
    if (isPhone(testInfo)) {
      await expect(input).toHaveAccessibleName('Nouvelle tâche');
      await input.focus();
    } else {
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleName(/^Nouvelle tâche pour (jeu\.) \d+$/);
    }

    await typeAndEnter(page, thursday, title, testInfo);
    await expect(taskButton(page, title)).toBeVisible();
    await expect.poll(() => dayTitles(page, thursday)).toEqual([title]);
    await expect(input).toHaveValue('');
    await expect(input).toBeFocused();
    // Sans heure : la carte PC n'affiche que l'espace ; la ligne iPhone porte un tiret dans la colonne d'heures (UI-REFONTE-03).
    if (isPhone(testInfo)) await expect(dayOf(page, thursday).locator('.ct-week-item__time')).toHaveText(['—']);
    else await expect(dayOf(page, thursday).locator('.ct-week-item__time')).toHaveCount(0);

    // Une tâche de plus à la suite, sans rouvrir le champ.
    await typeAndEnter(page, thursday, `${title} bis`, testInfo);
    await expect.poll(() => dayTitles(page, thursday)).toEqual([title, `${title} bis`]);

    // Enregistrée : elle survit au changement d'onglet.
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await weekTab(page).click();
    await expect.poll(() => dayTitles(page, thursday)).toEqual([title, `${title} bis`]);
  });

  test('Échap referme le champ sans rien créer ; un champ vide ou d’espaces ne crée rien (critère 4)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'UI-REFONTE-03 : la rangée d’ajout iPhone reste toujours visible, Échap n’a rien à refermer ; le titre vide est refusé par la même règle T-01.');
    const monday = await browserMonday(page);
    const tuesday = addIsoDays(monday, 1);
    await addButton(page, tuesday).click();
    await dayField(page, tuesday).fill('Abandonnée');
    await dayField(page, tuesday).press('Escape');
    await expect(dayField(page, tuesday)).toHaveCount(0);
    await expect(addButton(page, tuesday)).toBeFocused();
    await expect.poll(() => dayTitles(page, tuesday)).toEqual([]);

    await addButton(page, tuesday).click();
    await typeAndEnter(page, tuesday, '    ', testInfo);
    await expect(dayField(page, tuesday)).toBeVisible();
    await expect.poll(() => dayTitles(page, tuesday)).toEqual([]);

    // Quitter le champ vide (clic ailleurs) le referme.
    await page.getByRole('heading', { level: 1 }).click();
    await expect(dayField(page, tuesday)).toHaveCount(0);
  });

  test('la tâche est créée dans l’espace du filtre actif (critère 3) et l’ajout est permis sur un jour passé (critère 6)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    const title = `Perso lundi ${testInfo.project.name}`;
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    const input = await openField(page, monday, testInfo);
    await input.fill(title);
    // « lundi » est lu comme une date (Q-02) : on retire la pastille pour garder le titre.
    await page.getByRole('button', { name: /^Retirer/ }).click();
    await input.press('Enter');
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
      const input = await openField(page, iso, testInfo);
      await input.fill(title);
      await input.press('Enter');
      await expect(taskButton(page, title)).toBeVisible({ timeout: 500 });
    }
    for (const { iso, title } of plan) expect(await dayTitles(page, iso)).toEqual([title]);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('iPhone : la rangée d’ajout reste visible à l’écran, même en visant le dernier jour (critère 7)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Rangée d’ajout au-dessus du clavier : iPhone.');
    const sunday = addIsoDays(await browserMonday(page), 6);
    const input = await openField(page, sunday, testInfo);
    await expect(input).toHaveAttribute('placeholder', /^Ajouter à dimanche \d+$/);
    await expect(input).toBeInViewport({ ratio: 1 });
    await input.fill('Dimanche soir');
    await input.press('Enter');
    await expect(input).toBeInViewport({ ratio: 1 });
    await expect.poll(() => dayTitles(page, sunday)).toEqual(['Dimanche soir']);
  });
});
