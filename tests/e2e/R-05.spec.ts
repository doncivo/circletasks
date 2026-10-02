import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, openRoutines, reopenRoutines, routineForm } from './helpers/routines';
import { todayTab } from './helpers/today';
import { dayOf, openWeek } from './helpers/week';

/**
 * R-05 — Je mets une routine en pause ou l'archive.
 *
 * Date figée au mer. 23 sept. 2026. Couverture : pause par l'interrupteur du formulaire (plus d'occurrence dans Aujourd'hui ni la
 * Semaine, mention « En pause », historique intact), reprise ; « Archiver » avec confirmation, message « Annuler », section
 * « Archivées » repliée / absente, « Restaurer » (critères 1 à 3, 5, 8, 9). Exécuté sur `pc` et `iphone`.
 */
test.describe('R-05 — pause et archivage', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
  });

  async function openEdit(page: Page, title: string) {
    await cardOf(page, title).getByRole('button', { name: `Éditer la routine ${title}` }).click();
    return routineForm(page, 'Modifier la routine');
  }

  test('pause : plus d’occurrence dans Aujourd’hui ni la Semaine, « En pause » sur la carte, historique conservé ; reprise (critères 1 à 3)', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Faire mon lit', time: '07:30', done: ['2026-09-21', '2026-09-22'] }]);
    await reopenRoutines(page);
    const form = await openEdit(page, 'Faire mon lit');
    await expect(form.getByText('Aucune occurrence tant que la pause dure')).toBeVisible();
    await form.getByRole('switch', { name: 'Mettre en pause' }).click();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();

    const card = cardOf(page, 'Faire mon lit');
    await expect(card).toContainText('En pause');
    await expect(card.getByRole('checkbox', { name: 'Mardi, fait' })).toBeVisible(); // historique intact
    await expect(card.getByRole('checkbox', { name: 'Mercredi', exact: true })).toHaveAttribute('aria-disabled', 'true');

    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Faire mon lit' })).toHaveCount(0);
    await openWeek(page);
    await expect(dayOf(page, '2026-09-23').getByText('Faire mon lit')).toHaveCount(0);

    // Reprise : réapparaît dès aujourd'hui.
    await openRoutines(page);
    const again = await openEdit(page, 'Faire mon lit');
    await again.getByRole('switch', { name: 'Mettre en pause' }).click();
    await again.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(again).not.toBeVisible();
    await expect(cardOf(page, 'Faire mon lit')).not.toContainText('En pause');
    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Faire mon lit' })).toBeVisible();
  });

  test('archiver avec confirmation : la routine disparaît partout, « Annuler » la rend ; la section « Archivées » la liste (critères 5, 8, 9)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Faire mon lit', done: ['2026-09-22'] },
      { title: 'Sport' },
    ]);
    await reopenRoutines(page);
    await expect(page.getByRole('button', { name: /^Archivées/ })).toHaveCount(0);

    const form = await openEdit(page, 'Faire mon lit');
    await form.getByRole('button', { name: 'Archiver' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Archiver « Faire mon lit » ?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(form).toBeVisible();

    await form.getByRole('button', { name: 'Archiver' }).click();
    await dialog.getByRole('button', { name: 'Archiver' }).click();
    await expect(cardOf(page, 'Faire mon lit')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('« Faire mon lit » archivée');
    await expect(cardOf(page, 'Sport')).toBeVisible();

    // Section repliée par défaut, dépliable ; absente de Aujourd'hui.
    const toggle = page.getByRole('button', { name: 'Archivées (1)' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('list', { name: 'Routines archivées' })).toHaveCount(0);
    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Faire mon lit' })).toHaveCount(0);

    // Restaurer depuis la section.
    await openRoutines(page);
    await page.getByRole('button', { name: 'Archivées (1)' }).click();
    await page.getByRole('button', { name: 'Restaurer la routine Faire mon lit' }).click();
    await expect(cardOf(page, 'Faire mon lit')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Archivées/ })).toHaveCount(0);
    // L'historique est intact : la validation de mardi est toujours là.
    await expect(cardOf(page, 'Faire mon lit').getByRole('checkbox', { name: 'Mardi, fait' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('« Faire mon lit » restaurée');
    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Faire mon lit' })).toBeVisible();
  });

  test('« Annuler » du message d’archivage remet la routine dans la liste', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Faire mon lit' }]);
    await reopenRoutines(page);
    const form = await openEdit(page, 'Faire mon lit');
    await form.getByRole('button', { name: 'Archiver' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archiver' }).click();
    await expect(cardOf(page, 'Faire mon lit')).toHaveCount(0);
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(cardOf(page, 'Faire mon lit')).toBeVisible();
  });
});
