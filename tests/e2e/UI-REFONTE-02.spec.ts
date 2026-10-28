import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { createTask, openToday } from './helpers/today';

/**
 * UI-REFONTE-02 — Aujourd'hui sur iPhone : l'agenda du jour (docs/maquettes-refonte/Jour.html, Jour-Sombre.html).
 * Projets `iphone` (Chromium) et `iphone-webkit` (moteur de l'iPhone). Le PC est couvert par A-01 à A-09, inchangés.
 */

const onPhone = (): boolean => test.info().project.name.startsWith('iphone');

/** Ouvre le menu « Plus d’options » de l'en-tête et renvoie la feuille. */
async function openMore(page: Page) {
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  const menu = page.getByRole('dialog', { name: 'Plus d’options' });
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('UI-REFONTE-02 — agenda du jour sur iPhone', () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), 'Mise en page iPhone seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : en-tête sans badge, ligne « maintenant », colonne d'heures, dû en gros (critères 1, 5, 10)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.clock.setFixedTime(new Date('2026-09-23T14:32:00+02:00'));
      await openApp(page);
      await expect(page.locator('main h1.ct-today__day')).toBeVisible();
      await expect(page.locator('.ct-today__badge')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Plus d’options' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Rechercher' })).toBeVisible();

      await createTask(page, test.info(), { title: 'Appeler le notaire', time: '14:00' });
      await createTask(page, test.info(), { title: 'Relire le contrat', time: '16:30' });
      await createTask(page, test.info(), { title: 'Préparer le dépôt' });

      const nowLine = page.locator('.ct-agenda__now');
      await expect(nowLine).toBeVisible();
      await expect(nowLine).toHaveText(/14:32/);
      const due = page.locator('.ct-agenda__line[data-phase="due"]').filter({ hasText: 'Appeler le notaire' });
      await expect(due).toBeVisible();
      await expect(due).toContainText('En retard de 32 min');
      await expect(due.locator('.ct-agenda__hour')).toHaveText('14:00');
      await expect(page.locator('.ct-agenda__line[data-phase="upcoming"]').filter({ hasText: 'Relire le contrat' }).locator('.ct-agenda__hour')).toHaveText('16:30');
      await expect(page.locator('.ct-agenda__line[data-phase="untimed"]').filter({ hasText: 'Préparer le dépôt' }).locator('.ct-agenda__hour')).toHaveText('—');

      // Ordre vertical : dû, maintenant, à venir, sans heure.
      const order = await page.locator('.ct-agenda__line, .ct-agenda__now').evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? '').slice(0, 40)));
      const index = (text: string) => order.findIndex((line) => line.includes(text));
      expect(index('Appeler le notaire')).toBeLessThan(index('14:32'));
      expect(index('14:32')).toBeLessThan(index('Relire le contrat'));
      expect(index('Relire le contrat')).toBeLessThan(index('Préparer le dépôt'));

      // Le dû est en Fraunces et plus grand que les autres titres ; le trait « maintenant » traverse la ligne.
      const dueSize = await due.locator('.ct-list-row__title').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      const otherSize = await page.locator('.ct-agenda__line[data-phase="upcoming"] .ct-list-row__title').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      expect(dueSize).toBeGreaterThan(otherSize + 6);
      const bar = await nowLine.locator('.ct-agenda__nowBar').boundingBox();
      const main = await page.locator('main').boundingBox();
      expect(bar && main && bar.width > main.width * 0.6).toBeTruthy();
    });
  }

  test('menu « Plus d’options » : Mode édition et Vue compacte s’y commandent ; Objectif et Un jour s’ouvrent et reviennent par la gauche (critère 2, UI-FIX-04)', async ({ page }) => {
    await openToday(page);
    await createTask(page, test.info(), { title: 'À sélectionner' });
    let menu = await openMore(page);
    await expect(menu.getByRole('menuitem', { name: 'Un jour' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Objectif de la semaine' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rapport mensuel' })).toBeVisible();
    await menu.getByRole('menuitemcheckbox', { name: 'Mode édition' }).click();
    await expect(menu).toBeHidden();
    await expect(page.getByRole('button', { name: 'Sélectionner : À sélectionner' })).toBeVisible();
    menu = await openMore(page);
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Mode édition' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemcheckbox', { name: 'Mode édition' }).click();
    await expect(page.getByRole('button', { name: 'Sélectionner : À sélectionner' })).toHaveCount(0);

    menu = await openMore(page);
    await menu.getByRole('menuitemcheckbox', { name: 'Vue compacte' }).click();
    await expect(page.locator('.ct-list-row[data-compact="true"]').first()).toBeVisible();
    menu = await openMore(page);
    await menu.getByRole('menuitemcheckbox', { name: 'Vue compacte' }).click();
    await expect(page.locator('.ct-list-row[data-compact="true"]')).toHaveCount(0);

    // Objectif : écran plein, bouton de retour à gauche (UI-FIX-04), retour à l'agenda.
    menu = await openMore(page);
    await menu.getByRole('menuitem', { name: 'Objectif de la semaine' }).click();
    await expect(page.getByRole('heading', { level: 1, name: /Objectif/ })).toBeVisible();
    const back = page.getByRole('button', { name: 'Retour' });
    const box = await back.boundingBox();
    expect(box && box.x < 100).toBeTruthy();
    await back.click();
    await expect(page.locator('.ct-agenda__now')).toBeVisible();

    menu = await openMore(page);
    await menu.getByRole('menuitem', { name: 'Un jour' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Un jour' })).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.locator('.ct-agenda__now')).toBeVisible();
  });

  test('ajout : le champ rapide et le bouton « + » créent dans l’agenda ; les gestes et la fiche restent (critères 6, 7)', async ({ page }) => {
    await openToday(page);
    await createTask(page, test.info(), { title: 'Par le plus' });
    await expect(page.locator('.ct-agenda__line').filter({ hasText: 'Par le plus' })).toBeVisible();
    const quick = page.getByLabel('Nouvelle tâche');
    await quick.fill('Par le champ');
    await quick.press('Enter');
    await expect(page.locator('.ct-agenda__line').filter({ hasText: 'Par le champ' })).toBeVisible();
    // Case à cocher : terminer, la ligne reste à sa place (sans heure, elle reste dans le groupe sans heure, barrée).
    await page.getByRole('checkbox', { name: 'Terminer : Par le plus' }).click();
    await expect(page.locator('.ct-agenda__line').filter({ hasText: 'Par le plus' }).locator('.ct-list-row__title')).toHaveAttribute('data-done', 'true');
    // Fiche détail par le titre (A-08).
    await page.locator('.ct-agenda__line').filter({ hasText: 'Par le champ' }).locator('.ct-list-row__title').click();
    await expect(page.getByRole('dialog', { name: 'Détail de la tâche' })).toBeVisible();
  });

  test('zone de sécurité : l’en-tête commence sous la marge haute et la rangée d’ajout finit au-dessus de la marge basse (critère 11)', async ({ page }) => {
    await openToday(page);
    const title = await page.locator('main h1.ct-today__day').boundingBox();
    const add = await page.getByRole('button', { name: 'Ajouter', exact: true }).boundingBox();
    const viewport = page.viewportSize();
    expect(title && title.y >= 44).toBeTruthy();
    expect(add && viewport && add.y + add.height <= viewport.height - 16).toBeTruthy();
  });
});
