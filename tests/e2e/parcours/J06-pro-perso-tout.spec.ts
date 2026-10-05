import { expect, test } from '@playwright/test';
import { openApp } from '../helpers/app';
import { browserToday } from '../helpers/schedule';
import { insertTasks as insertStatTasks, openReport, tileOf } from '../helpers/stats';
import { filterPill } from '../helpers/spaces';
import { rowOf, todayTab } from '../helpers/today';
import { insertTasks, openWeek, taskButton, weekTab } from '../helpers/week';

/** Parcours clé 6 (PRD 8) : basculer Pro / Perso / Tout et vérifier le filtrage d'Aujourd'hui et de la Semaine (ES-02, ES-03). */
test('parcours 6 : filtrage Pro / Perso / Tout d’Aujourd’hui et de la Semaine', async ({ page }) => {
  await openApp(page);
  const today = await browserToday(page);
  await insertTasks(page, [
    { title: 'Facture client', date: today, space: 'pro', time: '09:00' },
    { title: 'Appeler maman', date: today, space: 'perso' },
  ]);
  await weekTab(page).click();
  await todayTab(page).click();

  await expect(rowOf(page, 'Facture client')).toBeVisible();
  await expect(rowOf(page, 'Appeler maman')).toBeVisible();

  await filterPill(page, 'Pro').click();
  await expect(rowOf(page, 'Facture client')).toBeVisible();
  await expect(rowOf(page, 'Appeler maman')).toHaveCount(0);
  await openWeek(page);
  await expect(taskButton(page, 'Facture client')).toBeVisible();
  await expect(taskButton(page, 'Appeler maman')).toHaveCount(0);

  await filterPill(page, 'Perso').click();
  await expect(taskButton(page, 'Appeler maman')).toBeVisible();
  await expect(taskButton(page, 'Facture client')).toHaveCount(0);
  await todayTab(page).click();
  await expect(rowOf(page, 'Appeler maman')).toBeVisible();
  await expect(rowOf(page, 'Facture client')).toHaveCount(0);

  await filterPill(page, 'Tout').click();
  await expect(rowOf(page, 'Facture client')).toBeVisible();
  await expect(rowOf(page, 'Appeler maman')).toBeVisible();
  await openWeek(page);
  await expect(taskButton(page, 'Facture client')).toBeVisible();
  await expect(taskButton(page, 'Appeler maman')).toBeVisible();
});

/**
 * Parcours clé 6, partie Statistiques (ES-08, H-01) : le rapport du mois suit le filtre d'espace. Mêmes tâches de septembre 2026, horloge
 * figée : Tout 4 faites sur 6, Pro 3 sur 4, Perso 1 sur 2 ; le filtre se change depuis le rapport lui-même, sans le quitter.
 */
test('parcours 6 (partie Statistiques) : le rapport du mois suit Pro, Perso et Tout', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-23T09:00:00+02:00'));
  await openApp(page);
  await insertStatTasks(page, [
    { title: 'Facture', date: '2026-09-10', done: true, space: 'pro' },
    { title: 'Devis', date: '2026-09-11', space: 'pro' },
    { title: 'Réunion', date: '2026-09-14', done: true, space: 'pro' },
    { title: 'Contrat', date: '2026-09-15', done: true, space: 'pro' },
    { title: 'Courses', date: '2026-09-12', done: true, space: 'perso' },
    { title: 'Dentiste', date: '2026-09-13', space: 'perso' },
  ]);
  await todayTab(page).click();
  await openReport(page, 'septembre');

  // Tout : toutes les tâches du mois.
  await expect(filterPill(page, 'Tout')).toHaveAttribute('aria-pressed', 'true');
  await expect(tileOf(page, 'Tâches faites : 4 sur 6')).toBeVisible();

  // Pro : les tâches Perso disparaissent des tuiles.
  await filterPill(page, 'Pro').click();
  await expect(tileOf(page, 'Tâches faites : 3 sur 4')).toBeVisible();
  await expect(page.getByTestId('month-rate')).toHaveText('Mois : 75 %');

  // Perso : l'inverse.
  await filterPill(page, 'Perso').click();
  await expect(tileOf(page, 'Tâches faites : 1 sur 2')).toBeVisible();
  await expect(page.getByTestId('month-rate')).toHaveText('Mois : 50 %');

  // Tout : retour aux chiffres d'ensemble, et le filtre reste celui d'Aujourd'hui en quittant le rapport.
  await filterPill(page, 'Tout').click();
  await expect(tileOf(page, 'Tâches faites : 4 sur 6')).toBeVisible();
  await expect(page.getByTestId('month-rate')).toHaveText('Mois : 67 %');
});
