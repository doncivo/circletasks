import { expect, test } from '@playwright/test';
import { openApp } from '../helpers/app';
import { cardOf, createRoutine, openRoutines } from '../helpers/routines';
import { isPhone } from '../helpers/today';

/**
 * Parcours clé 4 (PRD 8) : routine « 3 fois par semaine » créée par l'interface, validée trois jours de suite (horloge Playwright,
 * lundi 21 au mercredi 23 sept. 2026), puis série et rapport (R-01, R-03, R-04, R-06).
 */
test('parcours 4 : créer une routine 3 fois par semaine, la valider 3 jours, consulter série et rapport', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-09-21T09:00:00+02:00') });
  await openApp(page);
  await openRoutines(page);
  await createRoutine(page, testInfo, { title: 'Courir', frequency: 'x_per_week', times: 3, space: 'Perso' });
  const card = cardOf(page, 'Courir');
  await expect(card).toContainText('3 fois par semaine');

  for (const [index, day] of ['Lundi', 'Mardi', 'Mercredi'].entries()) {
    if (index > 0) {
      await page.clock.fastForward(24 * 60 * 60_000);
      await page.waitForTimeout(300);
    }
    await card.getByRole('checkbox', { name: day, exact: true }).click();
  }
  await expect(card).toContainText('série');

  // Rapport : série en cours, meilleure série, taux, trois jours faits dans la carte de chaleur.
  await card.locator('.ct-routine-card__info').click();
  const report = isPhone(testInfo)
    ? page.getByRole('dialog', { name: 'Rapport de la routine' })
    : page.getByRole('complementary', { name: 'Rapport de la routine' });
  await expect(report.getByRole('heading', { name: 'Courir' })).toBeVisible();
  await expect(report.getByText('Série en cours')).toBeVisible();
  await expect(report.getByText('Meilleure série')).toBeVisible();
  await expect(report.getByRole('group', { name: /Taux sur 7 jours : \d+ %/ })).toBeVisible();
  const grid = report.getByRole('group', { name: 'Carte de chaleur du mois' });
  for (const day of ['21', '22', '23']) await expect(grid.getByRole('img', { name: `${day} septembre, fait` })).toBeVisible();
});
