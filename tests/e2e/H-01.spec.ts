import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertFocusSessions } from './helpers/focus';
import { insertGoals } from './helpers/goals';
import { insertRoutines, openRoutines, reopenRoutines } from './helpers/routines';
import { filterPill } from './helpers/spaces';
import { insertTasks, openReport, reportButton, tileOf } from './helpers/stats';
import { isPhone, todayTab } from './helpers/today';

/**
 * H-01 — Je vois ce que j'ai accompli ce mois-ci. Date figée au mer. 23 sept. 2026. Rapport du mois : en-tête et flèches de mois,
 * quatre tuiles (tâches faites, routines, Focus, objectifs) qui suivent le filtre d'espace, section CONCENTRATION, carte des routines,
 * lien « Tâches terminées ». Exécuté sur `pc` et `iphone` (entrée par les Routines : iPhone).
 */
test.describe('H-01 — rapport du mois', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
    await insertTasks(page, [
      { title: 'A', date: '2026-09-02', done: true },
      { title: 'B', date: '2026-09-09', done: true },
      { title: 'C', date: '2026-09-16', done: true },
      { title: 'D', date: '2026-09-22' },
      { title: 'E', date: '2026-09-03', done: true, space: 'perso' },
      { title: 'F', date: '2026-09-10', space: 'perso' },
      { title: 'Futur', date: '2026-09-28' },
      { title: 'Août', date: '2026-08-20', done: true },
    ]);
    await insertGoals(page, [{ title: 'Finir le dossier', weekStart: '2026-09-07', status: 'achieved' }]);
    await insertFocusSessions(page, [{ startedAt: '2026-09-10T08:00:00.000Z', minutes: 90 }]);
    await insertRoutines(page, [{ title: 'Faire mon lit', space: 'pro', startDate: '2026-09-20', done: ['2026-09-20', '2026-09-21'] }]);
    await reopenRoutines(page);
    await todayTab(page).click();
  });

  test('critères 1 à 3, 5, 6 : l’icône graphique ouvre septembre ; « 4 sur 6 », Focus et objectifs', async ({ page }) => {
    await openReport(page, 'septembre');
    await expect(page.getByText('Rapport du mois', { exact: true })).toBeVisible();
    await expect(tileOf(page, 'Tâches faites : 4 sur 6')).toContainText('4 / 6');
    await expect(tileOf(page, 'Focus : 1 h 30')).toBeVisible();
    await expect(tileOf(page, 'Objectifs : 1 atteints sur 1')).toContainText('1 / 1 atteints');
  });

  test('critère 4 : taux des routines, jours futurs exclus (20 et 21 validés, 22 manqué)', async ({ page }) => {
    await openReport(page, 'septembre');
    await expect(tileOf(page, 'Routines : 67 %')).toBeVisible();
  });

  test('critère 7 : Pro puis Perso recalculent les tuiles', async ({ page }) => {
    await openReport(page, 'septembre');
    await filterPill(page, 'Pro').click();
    await expect(tileOf(page, 'Tâches faites : 3 sur 4')).toBeVisible();
    await expect(tileOf(page, 'Focus : 1 h 30')).toBeVisible();
    await filterPill(page, 'Perso').click();
    await expect(tileOf(page, 'Tâches faites : 1 sur 2')).toBeVisible();
    await expect(tileOf(page, 'Focus : 0 min')).toBeVisible();
    await expect(tileOf(page, 'Objectifs : aucun objectif')).toContainText('—');
    await expect(tileOf(page, 'Routines : aucune occurrence prévue')).toContainText('—');
    await filterPill(page, 'Tout').click();
    await expect(tileOf(page, 'Tâches faites : 4 sur 6')).toBeVisible();
  });

  test('critère 2 : mois précédent jusqu’à la plus ancienne donnée, jamais au-delà du mois courant', async ({ page }) => {
    await openReport(page, 'septembre');
    await expect(page.getByRole('button', { name: 'Mois suivant' })).toBeDisabled();
    await page.getByRole('button', { name: 'Mois précédent' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'août', exact: true })).toBeVisible();
    await expect(tileOf(page, 'Tâches faites : 1 sur 1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mois précédent' })).toBeDisabled();
    await page.getByRole('button', { name: 'Mois suivant' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'septembre', exact: true })).toBeVisible();
  });

  test('critère 8 : CONCENTRATION, carte des routines puis « Tâches terminées » ; retour à Aujourd’hui', async ({ page }) => {
    await openReport(page, 'septembre');
    await expect(page.getByRole('region', { name: 'CONCENTRATION' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'ROUTINES — JOURS COMPLÉTÉS' })).toBeVisible();
    await page.getByRole('button', { name: 'Tâches terminées' }).click();
    await expect(page.getByRole('heading', { name: 'Tâches terminées', level: 1 })).toBeVisible();
  });

  test('critère 10 : « Rapport du mois » des Routines ouvre le même écran (iPhone) et « Retour » ramène aux Routines', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'bouton iPhone');
    await openRoutines(page);
    await page.getByRole('button', { name: 'Rapport du mois' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'septembre', exact: true })).toBeVisible();
    await expect(tileOf(page, 'Tâches faites : 4 sur 6')).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Routines' })).toBeVisible();
  });

  test('critère 9 : un mois sans donnée affiche « Rien à compter » et « Aller à Aujourd’hui »', async ({ page }) => {
    await openReport(page, 'septembre');
    await page.getByRole('button', { name: 'Mois précédent' }).click();
    // Août n'a qu'une tâche Pro : sous Perso, il n'y a rien à compter.
    await filterPill(page, 'Perso').click();
    await expect(page.getByRole('heading', { level: 2, name: 'Rien à compter en août.' })).toBeVisible();
    await page.getByRole('button', { name: 'Aller à Aujourd’hui' }).click();
    await expect(reportButton(page)).toBeVisible();
  });
});
