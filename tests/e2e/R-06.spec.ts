import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, openRoutines, reopenRoutines } from './helpers/routines';
import { isPhone } from './helpers/today';

/**
 * R-06 — Je consulte le rapport de routine.
 *
 * Date figée au mer. 23 sept. 2026. PC : carte sélectionnée, panneau « Rapport de la routine » (tuiles 7 / 30 / 90 jours, séries,
 * carte de chaleur du mois avec flèches, Fermer / Échap, Modifier). iPhone : toucher le corps de la carte ouvre la feuille de
 * rapport, « Éditer » le formulaire, « Rapport du mois » la vue mensuelle de toutes les routines (QB-06). Exécuté sur `pc` et `iphone`.
 */
test.describe('R-06 — rapport de routine', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
    // Sport lun., mer., ven. : 7 jours (17 -> 23 sept.) = prévus ven. 18, lun. 21, mer. 23 ; validés 18 et 23 = 2 sur 3.
    await insertRoutines(page, [
      { title: 'Sport', space: 'perso', time: '18:00', icon: 'lucide:dumbbell', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: '2026-06-01', done: ['2026-09-14', '2026-09-16', '2026-09-18', '2026-09-23'] },
      { title: 'Faire mon lit', space: 'perso', done: ['2026-09-21', '2026-09-22'] },
    ]);
    await reopenRoutines(page);
  });

  const reportOf = (page: Page, testInfo: { project: { name: string } }) =>
    isPhone(testInfo) ? page.getByRole('dialog', { name: 'Rapport de la routine' }) : page.getByRole('complementary', { name: 'Rapport de la routine' });

  async function openReport(page: Page, testInfo: { project: { name: string } }) {
    // Corps de la carte (hors ronds et « Éditer ») : la ligne d'informations.
    await cardOf(page, 'Sport').locator('.ct-routine-card__info').click();
    const report = reportOf(page, testInfo);
    await expect(report).toBeVisible();
    return report;
  }

  test('toucher / cliquer la carte ouvre le rapport : nom, fréquence, tuiles 7, 30, 90 jours, séries (critères 1, 5, 6)', async ({ page }, testInfo) => {
    const report = await openReport(page, testInfo);
    await expect(report.getByRole('heading', { name: 'Sport' })).toBeVisible();
    await expect(report.getByText('Lundi, mercredi, vendredi à 18:00 · Perso')).toBeVisible();
    await expect(report.getByRole('group', { name: 'Taux sur 7 jours : 67 %' })).toContainText('7 JOURS');
    await expect(report.getByRole('group', { name: /Taux sur 30 jours : \d+ %/ })).toBeVisible();
    await expect(report.getByRole('group', { name: /Taux sur 90 jours : \d+ %/ })).toBeVisible();
    await expect(report.getByText('Série en cours')).toBeVisible();
    await expect(report.getByText('Meilleure série')).toBeVisible();
    if (!isPhone(testInfo)) await expect(cardOf(page, 'Sport')).toHaveAttribute('data-selected', 'true');
  });

  test('carte de chaleur : états des jours, libellés « 23 septembre, fait », mois précédent / suivant limité au mois courant (critères 3, 4, 7)', async ({ page }, testInfo) => {
    const report = await openReport(page, testInfo);
    await expect(report.getByText('SEPTEMBRE 2026')).toBeVisible();
    const grid = report.getByRole('group', { name: 'Carte de chaleur du mois' });
    await expect(grid.getByRole('img', { name: '23 septembre, fait' })).toHaveAttribute('data-today', 'true');
    await expect(grid.getByRole('img', { name: '21 septembre, prévu, non fait' })).toHaveAttribute('data-state', 'missed');
    await expect(grid.getByRole('img', { name: '25 septembre, prévu' })).toHaveAttribute('data-state', 'upcoming');
    await expect(grid.getByRole('img', { name: '22 septembre' })).toHaveAttribute('data-state', 'none');
    await expect(grid.getByRole('img')).toHaveCount(30);

    const next = report.getByRole('button', { name: 'Mois suivant' });
    await expect(next).toBeDisabled();
    await report.getByRole('button', { name: 'Mois précédent' }).click();
    await expect(report.getByText('AOÛT 2026')).toBeVisible();
    await expect(grid.getByRole('img')).toHaveCount(31);
    await expect(next).toBeEnabled();
    await next.click();
    await expect(report.getByText('SEPTEMBRE 2026')).toBeVisible();
    await expect(next).toBeDisabled();
  });

  test('Fermer ferme le rapport ; PC : Échap aussi ; un rond de la carte ne l’ouvre pas', async ({ page }, testInfo) => {
    await cardOf(page, 'Faire mon lit').getByRole('checkbox', { name: 'Mercredi', exact: true }).click();
    await expect(reportOf(page, testInfo)).toHaveCount(0);
    const report = await openReport(page, testInfo);
    await report.getByRole('button', { name: 'Fermer' }).click();
    await expect(reportOf(page, testInfo)).toHaveCount(0);
    await openReport(page, testInfo);
    await page.keyboard.press('Escape');
    await expect(reportOf(page, testInfo)).toHaveCount(0);
  });

  test('PC : « Modifier » ouvre le formulaire dans le panneau ; iPhone : « Éditer » est le seul accès au formulaire', async ({ page }, testInfo) => {
    const report = await openReport(page, testInfo);
    if (isPhone(testInfo)) {
      await expect(report.getByRole('button', { name: 'Modifier' })).toHaveCount(0);
      await report.getByRole('button', { name: 'Fermer' }).click();
      await cardOf(page, 'Sport').getByRole('button', { name: 'Éditer la routine Sport' }).click();
    } else {
      await report.getByRole('button', { name: 'Modifier' }).click();
    }
    await expect(page.getByRole('form', { name: 'Modifier la routine' })).toBeVisible();
  });

  test('PC : « Mettre en pause » et « Archiver » depuis le panneau', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'panneau de droite : PC');
    const report = await openReport(page, testInfo);
    await report.getByRole('button', { name: 'Mettre en pause' }).click();
    await expect(report.getByRole('button', { name: 'Reprendre' })).toBeVisible();
    await expect(cardOf(page, 'Sport')).toContainText('En pause');
    await report.getByRole('button', { name: 'Archiver' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archiver' }).click();
    await expect(cardOf(page, 'Sport')).toHaveCount(0);
    await expect(report).toHaveCount(0);
  });

  test('iPhone : « Rapport du mois » ouvre la vue mensuelle de toutes les routines (critère 6, QB-06)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'bouton iPhone');
    await page.getByRole('button', { name: 'Rapport du mois' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'septembre' })).toBeVisible();
    const grid = page.getByRole('group', { name: 'ROUTINES — JOURS COMPLÉTÉS' });
    // Mercredi 23 : Sport validé, « Faire mon lit » non (aujourd'hui, à venir) : 1 sur 2.
    await expect(grid.getByRole('img', { name: '23 septembre, 1 sur 2' })).toHaveAttribute('data-today', 'true');
    await expect(grid.getByRole('img', { name: '22 septembre, tout validé : 1 sur 1' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Taux du mois par routine' }).getByText('Faire mon lit')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mois suivant' })).toBeDisabled();
    await page.getByRole('button', { name: 'Mois précédent' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'août' })).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
    await openRoutines(page);
  });
});
