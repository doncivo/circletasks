import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test';
import { isPhone, openToday, createTask } from './helpers/today';
import { openWeek } from './helpers/week';

/**
 * A-07 — J'agis d'un geste sur iPhone.
 *
 * Couverture (projet `iphone`, gestes simulés au toucher par le protocole Chrome DevTools) : balayage à droite qui termine avec
 * « Annuler » (critère 1), balayage à gauche puis « Reporter », « Un jour » et « Supprimer » avec confirmation (3 à 6), appui long qui
 * ouvre la fiche (8), mode édition sans geste (9), Semaine : la ligne puis l'en-tête (11), équivalents boutons (16), thème sombre.
 * Projet `pc` : aucun geste, aucune ligne enveloppée (12). Le toucher n'est jamais simulé avec des attentes fixes : l'appui long
 * est tenu pendant que le test attend, par relances, l'ouverture de la fiche.
 */

async function touchSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

async function touchDown(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
}

async function touchMove(cdp: CDPSession, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
}

async function touchUp(cdp: CDPSession): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Doigt posé en (x0, y), amené en (x1, y) en `steps` mouvements ; relâché sauf si `release` est faux. */
async function drag(page: Page, x0: number, x1: number, y: number, options: { steps?: number; release?: boolean } = {}): Promise<CDPSession> {
  const cdp = await touchSession(page);
  const steps = options.steps ?? 8;
  await touchDown(cdp, x0, y);
  for (let i = 1; i <= steps; i += 1) await touchMove(cdp, x0 + ((x1 - x0) * i) / steps, y);
  if (options.release !== false) await touchUp(cdp);
  return cdp;
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('élément sans boîte');
  return box;
}

/** Ligne à geste d'une tâche, par son titre. */
const swipeRowOf = (page: Page, title: string): Locator => page.locator('.ct-swipe-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });

/** Balayage vers la droite jusqu'à 70 % de la largeur de la ligne. */
async function swipeRight(page: Page, row: Locator): Promise<void> {
  const box = await boxOf(row);
  const y = box.y + box.height / 2;
  await drag(page, box.x + box.width * 0.2, box.x + box.width * 0.9, y);
}

/** Balayage vers la gauche de 40 % de la largeur : la ligne reste ouverte. */
async function swipeLeft(page: Page, row: Locator): Promise<void> {
  const box = await boxOf(row);
  const y = box.y + box.height / 2;
  await drag(page, box.x + box.width * 0.8, box.x + box.width * 0.4, y);
  await expect(row).toHaveAttribute('data-open', 'true');
}

const status = (page: Page): Locator => page.getByRole('status');
const detailOf = (page: Page): Locator => page.getByRole('dialog', { name: 'Détail de la tâche' });

test.describe('A-07 — gestes de ligne sur iPhone', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('balayage à droite : la tâche est terminée, bandeau « Annuler », puis annulation (critère 1)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste terminer' });
    const row = swipeRowOf(page, 'Geste terminer');
    await expect(row.getByRole('checkbox', { name: 'Terminer : Geste terminer' })).toHaveAttribute('aria-checked', 'false');
    await swipeRight(page, row);
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Geste terminer' })).toHaveAttribute('aria-checked', 'true');
    await expect(status(page)).toContainText('Geste terminer');
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('checkbox', { name: 'Terminer : Geste terminer' })).toHaveAttribute('aria-checked', 'false');
  });

  test('balayage à droite en deçà du seuil : aucun effet (critère 1)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste court' });
    const row = swipeRowOf(page, 'Geste court');
    const box = await boxOf(row);
    const cdp = await drag(page, box.x + 40, box.x + 40 + 25, box.y + box.height / 2, { steps: 5, release: false });
    // Le fond vert est visible pendant le geste, avant le lâcher.
    await expect(row.locator('.ct-swipe-row__under--right')).toContainText('Terminer');
    await touchUp(cdp);
    await expect(row.locator('.ct-swipe-row__under')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Terminer : Geste court' })).toHaveAttribute('aria-checked', 'false');
  });

  test('balayage à gauche puis « Reporter » : demain, message et annulation (critères 3 et 4)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste reporter' });
    const row = swipeRowOf(page, 'Geste reporter');
    await swipeLeft(page, row);
    await expect(row.locator('.ct-swipe-row__button')).toHaveText(['Reporter', 'Un jour', 'Supprimer']);
    await row.locator('[data-action="postpone"]').click();
    await expect(status(page)).toContainText('« Geste reporter » reportée à demain');
    await expect(page.getByRole('button', { name: 'Geste reporter', exact: true })).toHaveCount(0);
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: 'Geste reporter', exact: true })).toBeVisible();
  });

  test('« Un jour » range la tâche avec annulation (critère 5)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste un jour' });
    const row = swipeRowOf(page, 'Geste un jour');
    await swipeLeft(page, row);
    await row.locator('[data-action="someday"]').click();
    await expect(status(page)).toContainText('Un jour');
    await expect(page.getByRole('button', { name: 'Geste un jour', exact: true })).toHaveCount(0);
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: 'Geste un jour', exact: true })).toBeVisible();
  });

  test('« Supprimer » : confirmation habituelle ; annuler la boîte laisse la ligne ; confirmer supprime (critère 6)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste supprimer' });
    const row = swipeRowOf(page, 'Geste supprimer');
    await swipeLeft(page, row);
    await row.locator('[data-action="delete"]').click();
    const dialog = page.getByRole('alertdialog', { name: 'Supprimer « Geste supprimer » ?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row).not.toHaveAttribute('data-open', 'true');
    await expect(page.getByRole('button', { name: 'Geste supprimer', exact: true })).toBeVisible();

    await swipeLeft(page, row);
    await row.locator('[data-action="delete"]').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
    await expect(page.getByRole('button', { name: 'Geste supprimer', exact: true })).toHaveCount(0);
    await expect(status(page)).toContainText('« Geste supprimer » supprimée');
  });

  test('équivalents boutons pour VoiceOver : même effet que le geste (critère 16)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste bouton' });
    await expect(page.getByRole('group', { name: 'Actions : Geste bouton' })).toBeAttached();
    await page.getByRole('button', { name: 'Reporter : Geste bouton' }).focus();
    await expect(page.getByRole('group', { name: 'Actions : Geste bouton' })).toBeVisible();
    await page.getByRole('button', { name: 'Reporter : Geste bouton' }).click();
    await expect(status(page)).toContainText('« Geste bouton » reportée à demain');
  });

  test('appui long : la fiche détail s’ouvre (critère 8)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste fiche' });
    const box = await boxOf(swipeRowOf(page, 'Geste fiche'));
    const cdp = await touchSession(page);
    await touchDown(cdp, box.x + box.width * 0.5, box.y + box.height / 2);
    // Le doigt reste immobile : la fiche s’ouvre au bout de 500 ms (attente par relances, sans délai fixe).
    await expect(detailOf(page)).toBeVisible();
    await touchUp(cdp);
    await expect(detailOf(page)).toBeVisible();
  });

  test('mode édition : aucun geste, rond de sélection à la place de la case (critère 9)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste édition' });
    await page.getByRole('button', { name: 'Mode édition' }).click();
    await expect(page.getByRole('group', { name: 'Actions : Geste édition' })).toHaveCount(0);
    const row = swipeRowOf(page, 'Geste édition');
    await swipeRight(page, row);
    await expect(row.locator('.ct-swipe-row__under')).toHaveCount(0);
    await page.getByRole('button', { name: 'Mode édition' }).click();
    await expect(page.getByRole('checkbox', { name: 'Terminer : Geste édition' })).toHaveAttribute('aria-checked', 'false');
  });

  test('Semaine : la ligne réagit, la semaine ne change pas ; sur l’en-tête, elle change (critère 11)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await createTask(page, testInfo, { title: 'Geste semaine' });
    await openWeek(page);
    const title = page.getByRole('heading', { level: 1 });
    const before = await title.textContent();
    const row = swipeRowOf(page, 'Geste semaine');
    await swipeRight(page, row);
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Geste semaine' })).toHaveAttribute('aria-checked', 'true');
    await expect(title).toHaveText(before ?? '');

    const head = page.locator('.ct-week-day[data-today] .ct-week-day__head');
    const box = await boxOf(head);
    await drag(page, box.x + box.width / 2, box.x + box.width / 2 - 250, box.y + box.height / 2);
    await expect(title).not.toHaveText(before ?? '');
  });

  test('thème sombre : le fond vert et les boutons restent lisibles', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Gestes tactiles de l’iPhone.');
    await page.emulateMedia({ colorScheme: 'dark' });
    await createTask(page, testInfo, { title: 'Geste sombre' });
    const row = swipeRowOf(page, 'Geste sombre');
    const box = await boxOf(row);
    const cdp = await drag(page, box.x + 40, box.x + 140, box.y + box.height / 2, { release: false });
    await expect(row.locator('.ct-swipe-row__under--right')).toHaveCSS('background-color', 'rgb(62, 124, 90)');
    await touchUp(cdp);
    await swipeLeft(page, row);
    await expect(row.locator('[data-action="delete"]')).toHaveCSS('background-color', 'rgb(161, 39, 28)');
  });

  test('PC : aucune ligne enveloppée, le balayage n’a aucun effet (critère 12)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Vérification du projet pc.');
    await createTask(page, testInfo, { title: 'Geste pc' });
    await expect(page.getByRole('button', { name: 'Geste pc', exact: true })).toBeVisible();
    await expect(page.locator('.ct-swipe-row')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Actions : Geste pc' })).toHaveCount(0);
  });
});
