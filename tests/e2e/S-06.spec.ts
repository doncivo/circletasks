import { expect, test, type Locator, type Page } from '@playwright/test';
import { addIsoDays, browserToday, dayLabel } from './helpers/schedule';
import { insertSomeday, openSomeday, somedayTitles } from './helpers/someday';
import { isPhone, openToday, todayTab } from './helpers/today';
import { browserMonday, dayOf, dayTitles, openWeek, weekTab } from './helpers/week';

/**
 * S-06 — Je planifie depuis « Un jour » en glissant. Parcours clé 12 (glisser vers un jour). PC : panneau « Un jour » à droite de la
 * Semaine, glisser-déposer vers un jour ; iPhone : « Aujourd'hui », « Demain », « Choisir une date » dans la ligne dépliée.
 */
const box = async (locator: Locator) => {
  const found = await locator.boundingBox();
  if (!found) throw new Error('élément introuvable à l’écran');
  return found;
};

/** Souris : saisit la carte, la porte au centre de `to` par petits pas, laisse la main au test avant le lâcher. */
async function mouseDragTo(page: Page, card: Locator, to: Locator, release = true): Promise<void> {
  const from = await box(card);
  const target = await box(to);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 12, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height - 8, 120), { steps: 12 });
  if (release) await page.mouse.up();
}

const panel = (page: Page): Locator => page.getByRole('complementary', { name: 'Un jour' });
const panelCard = (page: Page, title: string): Locator => panel(page).locator('[data-drag-id]').filter({ has: page.getByRole('button', { name: title, exact: true }) });
const panelTitles = (page: Page): Promise<string[]> => panel(page).locator('.ct-list-row__title').allTextContents();

test.describe('S-06 — planifier depuis « Un jour » en glissant', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('PC : le bouton de l’en-tête ouvre le panneau, la grille garde ses sept jours ; Fermer et Échap le ferment (critères 1 et 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Panneau à droite de la Semaine : PC.');
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }, { title: 'Lire le rapport annuel', space: 'perso' }]);
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toContainText('Glissez une tâche vers un jour pour la planifier.');
    await expect(page.locator('.ct-week-day')).toHaveCount(7);
    for (const column of await page.locator('.ct-week-day').all()) await expect(column).toBeInViewport({ ratio: 0.9 });
    expect(await panelTitles(page)).toEqual(['Renouveler le passeport', 'Lire le rapport annuel']);

    await panel(page).getByRole('button', { name: 'Fermer le panneau' }).click();
    await expect(panel(page)).toBeHidden();
    await page.getByRole('button', { name: /^Un jour/ }).click();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
  });

  test('PC : l’état ouvert du panneau est conservé en changeant d’onglet (critère 7)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Panneau à droite de la Semaine : PC.');
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    await expect(panel(page)).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Routines', exact: true }).click();
    await weekTab(page).click();
    await expect(panel(page)).toBeVisible();
  });

  test('PC : glisser une carte vers jeudi : zone « Déposer ici », tâche datée sans heure, message, Annuler (critères 3 et 4)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Glisser-déposer entre le panneau et la grille : PC.');
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }, { title: 'Préparer la présentation Q4' }, { title: 'Lire le rapport annuel' }]);
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    const thursday = addIsoDays(await browserMonday(page), 3);
    expect(await panelTitles(page)).toEqual(['Renouveler le passeport', 'Préparer la présentation Q4', 'Lire le rapport annuel']);

    await mouseDragTo(page, panelCard(page, 'Préparer la présentation Q4'), dayOf(page, thursday), false);
    await expect(page.getByText(`Déposer ici · ${dayLabel(thursday).replace(/ [a-zéû]+\.?$/, '')}`)).toBeVisible();
    await page.mouse.up();

    await expect(dayOf(page, thursday)).toContainText('Préparer la présentation Q4');
    await expect.poll(() => panelTitles(page)).toEqual(['Renouveler le passeport', 'Lire le rapport annuel']);
    expect(await dayTitles(page, thursday)).toEqual(['Préparer la présentation Q4']);
    // Sans heure : la sous-ligne de la carte n'a pas d'horaire.
    await expect(dayOf(page, thursday)).not.toContainText(/\d\d:\d\d/);
    const status = page.getByRole('status');
    // Message relatif au jour courant (createTaskUseCases) : le jeudi visé peut être aujourd’hui ou demain.
    const today = await browserToday(page);
    const when =
      thursday === today ? 'pour aujourd’hui' : thursday === addIsoDays(today, 1) ? 'pour demain' : `au ${dayLabel(thursday)}`;
    await expect(status).toContainText(`« Préparer la présentation Q4 » planifiée ${when}`);

    await status.getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(() => panelTitles(page)).toEqual(['Renouveler le passeport', 'Préparer la présentation Q4', 'Lire le rapport annuel']);
    await expect(dayOf(page, thursday)).not.toContainText('Préparer la présentation Q4');
  });

  test('PC : Ctrl+Z renvoie la tâche planifiée dans le panneau (critère 4)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Glisser-déposer : PC.');
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }]);
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    const wednesday = addIsoDays(await browserMonday(page), 2);
    await mouseDragTo(page, panelCard(page, 'Renouveler le passeport'), dayOf(page, wednesday));
    await expect(dayOf(page, wednesday)).toContainText('Renouveler le passeport');
    await page.keyboard.press('Control+z');
    await expect.poll(() => panelTitles(page)).toEqual(['Renouveler le passeport']);
  });

  test('PC : un lâcher hors de la grille, ou Échap pendant le glisser, ne change rien (critère 5)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Glisser-déposer : PC.');
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }]);
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    const friday = addIsoDays(await browserMonday(page), 4);
    // Lâcher sur l'en-tête de page, hors de toute zone.
    const from = await box(panelCard(page, 'Renouveler le passeport'));
    await page.mouse.move(from.x + 40, from.y + 20);
    await page.mouse.down();
    await page.mouse.move(from.x - 100, from.y - 300, { steps: 8 });
    await page.mouse.up();
    // Échap pendant le glisser.
    await mouseDragTo(page, panelCard(page, 'Renouveler le passeport'), dayOf(page, friday), false);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(await panelTitles(page)).toEqual(['Renouveler le passeport']);
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });

  test('PC : « + Ajouter à « Un jour » » crée une tâche sans date dans le panneau (critère 6)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Panneau : PC.');
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    await panel(page).getByRole('button', { name: '+ Ajouter à « Un jour »' }).click();
    const field = panel(page).getByRole('combobox', { name: 'Nouvelle tâche sans date' });
    await field.fill('Renouveler le passeport');
    await field.press('Enter');
    await expect.poll(() => panelTitles(page)).toEqual(['Renouveler le passeport']);
  });

  test('PC : clavier, tâche sélectionnée dans le panneau puis Entrée : la fiche s’ouvre (critère 8)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Clavier du panneau : PC.');
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }]);
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    await panel(page).getByRole('button', { name: 'Renouveler le passeport', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary', { name: 'Détail de la tâche' })).toBeVisible();
    await page.getByRole('complementary', { name: 'Détail de la tâche' }).getByRole('button', { name: /^Date de la tâche/ }).click();
    await expect(page.getByRole('combobox', { name: 'Date de la tâche' })).toBeVisible();
  });

  test('iPhone : « Planifier » déplie la tâche ; « Aujourd’hui » l’envoie dans Aujourd’hui et la Semaine, annulable (critères 9 et 10)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Action « Planifier » : iPhone.');
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }, { title: 'Lire le rapport annuel' }]);
    await weekTab(page).click();
    await todayTab(page).click();
    await openSomeday(page, testInfo);
    await page.getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Planifier demain : Renouveler le passeport' })).toBeVisible();
    await page.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Lire le rapport annuel']);
    const status = page.getByRole('status');
    await expect(status).toContainText('« Renouveler le passeport » planifiée pour aujourd’hui');

    const today = await browserToday(page);
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.getByRole('button', { name: 'Renouveler le passeport', exact: true })).toBeVisible();
    await openWeek(page);
    await expect(dayOf(page, today)).toContainText('Renouveler le passeport');

    await status.getByRole('button', { name: 'Annuler' }).click();
    await expect(dayOf(page, today)).not.toContainText('Renouveler le passeport');
  });
});
