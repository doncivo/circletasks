import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createTask, isPhone, listTitles, openToday, rowOf } from './helpers/today';

/**
 * A-05 — Je passe en mode édition.
 *
 * Couverture : interrupteur « Mode édition » et commandes par ligne (critères 1, 12), « − » avec confirmation et
 * annulation (2), glisser la poignée à la souris (PC) et au toucher (iPhone, événements tactiles réels via CDP)
 * (3, A-02 critère 1), barre « N sélectionnées » (4), Reporter par lot en une seule annulation (5), Supprimer
 * par lot (6), Déplacer vers un autre espace (7), mode non mémorisé au changement d'onglet (9), Échap, Ctrl+clic
 * et Maj+clic, Suppr (10, PC), champ d'ajout utilisable (11). Exécuté sur `pc` et `iphone`.
 * Routines (Q13) : tests unitaires, le module n'existe pas encore.
 */
const toggle = (page: Page) => page.getByRole('button', { name: 'Mode édition' });
const select = (page: Page, title: string) => page.getByRole('button', { name: `Sélectionner : ${title}` }).click();
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Actions sur la sélection' });
const status = (page: Page) => page.getByRole('status');

async function seed(page: Page, testInfo: TestInfo, names: string[]): Promise<string[]> {
  const titles = names.map((name) => `${name} ${testInfo.project.name}`);
  for (const title of titles) await createTask(page, testInfo, { title });
  return titles;
}

test.describe('A-05 — mode édition', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('les commandes d’édition remplacent les cases, et l’interrupteur ramène au mode normal (critères 1, 9, 12)', async ({ page }, testInfo) => {
    const [a] = (await seed(page, testInfo, ['Facture'])) as [string];
    await expect(page.getByRole('checkbox', { name: `Terminer : ${a}` })).toBeVisible();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${a}` })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Sélectionner : ${a}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Supprimer : ${a}` })).toBeVisible();
    await expect(page.getByRole('button', { name: `Déplacer : ${a}` })).toBeVisible();
    // Le mode n'est pas mémorisé quand on change d'onglet.
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${a}` })).toBeVisible();
  });

  test('« − » supprime après confirmation et s’annule (critère 2)', async ({ page }, testInfo) => {
    const [a, b] = (await seed(page, testInfo, ['Courses', 'Autre'])) as [string, string];
    await toggle(page).click();
    await page.getByRole('button', { name: `Supprimer : ${a}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
    await expect(page.getByRole('button', { name: a, exact: true })).toHaveCount(0);
    await expect(status(page)).toContainText(`« ${a} » supprimée`);
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: a, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: b, exact: true })).toBeVisible();
  });

  test('la barre de sélection compte, reporte en une annulation et supprime par lot (critères 4, 5, 6)', async ({ page }, testInfo) => {
    const [a, b, c] = (await seed(page, testInfo, ['A', 'B', 'C'])) as [string, string, string];
    await toggle(page).click();
    await expect(bar(page)).toHaveCount(0);
    await select(page, a);
    await expect(bar(page)).toContainText('1 sélectionnée');
    await select(page, b);
    await expect(bar(page)).toContainText('2 sélectionnées');

    await bar(page).getByRole('button', { name: 'Reporter' }).click();
    await page.getByRole(isPhone(testInfo) ? 'button' : 'menuitem', { name: 'Demain' }).click();
    await expect.poll(() => listTitles(page)).toEqual([c]);
    await expect(status(page)).toContainText('2 tâches reportées');
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(async () => (await listTitles(page)).sort()).toEqual([a, b, c].sort());

    await select(page, b);
    await select(page, c);
    await bar(page).getByRole('button', { name: 'Supprimer' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Supprimer 2 tâches ?');
    await dialog.getByRole('button', { name: 'Supprimer' }).click();
    await expect.poll(() => listTitles(page)).toEqual([a]);
    await expect(status(page)).toContainText('2 tâches supprimées');
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(async () => (await listTitles(page)).sort()).toEqual([a, b, c].sort());
  });

  test('« Déplacer » change l’espace de la sélection, pas la date (critère 7, Q12)', async ({ page }, testInfo) => {
    const [a, b] = (await seed(page, testInfo, ['A', 'B'])) as [string, string];
    await toggle(page).click();
    await select(page, a);
    await select(page, b);
    await bar(page).getByRole('button', { name: 'Déplacer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Perso' }).click();
    await expect(status(page)).toContainText('2 tâches déplacées');
    await toggle(page).click();
    await expect(rowOf(page, a).locator('.ct-list-row__subtitle')).toHaveText('Perso');
    await expect(rowOf(page, b).locator('.ct-list-row__subtitle')).toHaveText('Perso');
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(rowOf(page, a).locator('.ct-list-row__subtitle')).toHaveText('Pro');
  });

  test('glisser la poignée réordonne la liste : souris sur PC, toucher sur iPhone (critère 3)', async ({ page }, testInfo) => {
    const [a, b, c] = (await seed(page, testInfo, ['A', 'B', 'C'])) as [string, string, string];
    await toggle(page).click();
    const handle = (title: string) => page.getByRole('button', { name: `Déplacer : ${title}` });
    const from = await handle(c).boundingBox();
    const to = await handle(a).boundingBox();
    if (!from || !to) throw new Error('poignées introuvables');
    const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    const end = { x: to.x + to.width / 2, y: to.y + 4 };

    if (isPhone(testInfo)) {
      // Événements tactiles réels : le navigateur émet des pointeurs `touch`, la poignée a `touch-action: none`.
      const client = await page.context().newCDPSession(page);
      const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', point?: { x: number; y: number }) =>
        client.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });
      await touch('touchStart', start);
      for (let step = 1; step <= 8; step += 1) {
        await touch('touchMove', { x: start.x + ((end.x - start.x) * step) / 8, y: start.y + ((end.y - start.y) * step) / 8 });
      }
      await touch('touchEnd');
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x, start.y - 20, { steps: 3 });
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
    }
    await expect.poll(() => listTitles(page)).toEqual([c, a, b]);
    // Le glisser a aussi un équivalent au clavier sur la poignée : ↓ descend d'une position.
    await handle(c).focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => listTitles(page)).toEqual([a, c, b]);
  });

  test('PC : Ctrl+clic, Maj+clic, Suppr et Échap (critère 10)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Raccourcis clavier et souris du PC.');
    const [a, b, c] = (await seed(page, testInfo, ['A', 'B', 'C'])) as [string, string, string];
    await toggle(page).click();
    await page.getByRole('button', { name: a, exact: true }).click({ modifiers: ['Control'] });
    await expect(bar(page)).toContainText('1 sélectionnée');
    await page.getByRole('button', { name: c, exact: true }).click({ modifiers: ['Shift'] });
    await expect(bar(page)).toContainText('3 sélectionnées');
    await expect(page.getByRole('complementary', { name: 'Détail de la tâche' })).toHaveCount(0);
    await page.getByRole('button', { name: b, exact: true }).focus();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('alertdialog')).toContainText('Supprimer 3 tâches ?');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(bar(page)).toHaveCount(0);
  });

  test('le champ « Ajouter une tâche » reste utilisable en mode édition (critère 11)', async ({ page }, testInfo) => {
    await seed(page, testInfo, ['A']);
    await toggle(page).click();
    const added = `Ajoutée ${testInfo.project.name}`;
    await createTask(page, testInfo, { title: added });
    await expect(page.getByRole('button', { name: `Sélectionner : ${added}` })).toBeVisible();
  });
});
