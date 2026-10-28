import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { eventRow, insertEvents, reopenEvents } from './helpers/events';
import { expectFitsViewport } from './helpers/layout';

/**
 * UI-REFONTE-07 — Événements sur iPhone (docs/maquettes-refonte/Evenements-v2.html). Horloge figée au mercredi 23 sept. 2026, fériés
 * France et Tunisie activés : fériés en gris sans badge avec le pays en toutes lettres, événement propre en encre avec « J-… », pastille
 * « Masquer les fériés », rangée du bas « Vue calendrier » + « Événement », thème sombre, largeur. Projets `iphone` et `iphone-webkit`.
 */

const onPhone = (): boolean => test.info().project.name.startsWith('iphone');

test.describe('UI-REFONTE-07 — Événements iPhone', () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), 'Mise en page iPhone seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : fériés en gris sans badge, événement en encre, pastille des fériés, rangée du bas (critères 1 à 5)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.clock.setFixedTime(new Date('2026-09-23T10:00:00+02:00'));
      await openApp(page, { holidays: true });
      await insertEvents(page, [{ title: 'Vol vers Tunis', date: '2026-12-03', space: 'perso', important: true }]);
      await reopenEvents(page);
      await expect(page.getByRole('heading', { level: 1, name: 'Événements' })).toBeVisible();
      await expect(page.locator('.ct-events__rule')).toHaveCount(0);

      const toussaint = eventRow(page, 'Toussaint');
      await expect(toussaint).toHaveAttribute('data-source', 'holiday');
      await expect(toussaint).toContainText('Jour férié en France');
      await expect(toussaint.locator('.ct-event-row__tag')).toHaveCount(0);
      await expect(page.getByText('Férié FR')).toHaveCount(0);
      const vol = eventRow(page, 'Vol vers Tunis');
      await expect(vol).toContainText('J-71');
      await expect(vol).toContainText('Journée entière · Perso');
      // Les fériés reculent : couleur du titre différente de celle d'un événement propre.
      const holidayColor = await toussaint.locator('.ct-event-row__title').evaluate((node) => getComputedStyle(node).color);
      const ownColor = await vol.locator('.ct-event-row__title').evaluate((node) => getComputedStyle(node).color);
      expect(holidayColor).not.toBe(ownColor);

      const toggle = page.getByRole('button', { name: 'Masquer les fériés' });
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await toggle.click();
      await expect(eventRow(page, 'Toussaint')).toHaveCount(0);
      await expect(eventRow(page, 'Vol vers Tunis')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Afficher les fériés' })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Afficher les fériés' }).click();
      await expect(eventRow(page, 'Toussaint')).toBeVisible();

      const row = page.locator('.ct-events__bottomRow');
      await expect(row.getByRole('button', { name: 'Vue calendrier' })).toBeVisible();
      const add = row.getByRole('button', { name: 'Ajouter un événement' });
      await expect(add).toHaveText(/Événement$/);
      await expect(page.locator('.ct-fab')).toHaveCount(0);
      const box = await row.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.y + box.height <= viewport.height).toBeTruthy();
      await expectFitsViewport(page, `Événements (${scheme})`);
    });
  }

  test('« Vue calendrier » ouvre la grille du mois ; « Événement » ouvre la feuille Ajout au segment Événement (critère 4)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T10:00:00+02:00'));
    await openApp(page, { holidays: true });
    await reopenEvents(page);
    await page.getByRole('button', { name: 'Vue calendrier' }).click();
    const sheet = page.getByRole('dialog', { name: 'Calendrier' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Fermer' }).click();
    await expect(sheet).toBeHidden();
    await page.getByRole('button', { name: 'Ajouter un événement' }).click();
    const form = page.getByRole('dialog', { name: 'Nouvel événement' });
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Événement', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
