import { expect, test } from '@playwright/test';
import { openApp } from '../helpers/app';
import { browserToday } from '../helpers/schedule';
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

// ES-08 : les Statistiques n'existent qu'à l'ordre 3 (module M8) ; à activer à ce moment-là.
test.fixme('parcours 6 (partie Statistiques) : le filtre d’espace s’applique aux Statistiques (ES-08, ordre 3)', async () => {
  // Basculer Pro / Perso / Tout et vérifier les chiffres de l'onglet Statistiques.
});
