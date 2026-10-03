import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { closeGoalScreen, goalCards, goalTitleField, openGoalScreen } from './helpers/goals';
import { detailOf } from './helpers/spaces';
import { createTask, rowOf } from './helpers/today';

/**
 * Parcours clé 12 (PRD section 8), partie objectif (OB-01, OB-03, OB-04) : fixer l'objectif, y rattacher 2 tâches, suivre l'avancement.
 * La partie « Un jour » et le glisser vers la Semaine relèvent de SD-01, SD-02 et S-06. Exécuté sur `pc` et `iphone`.
 */
test('parcours 12 (objectif) : fixer l’objectif, rattacher 2 tâches, l’encadré passe de 0/2 à 1/2', async ({ page }, testInfo) => {
  await openApp(page);
  await openGoalScreen(page);
  await goalTitleField(page).fill('Finaliser le PRD CircleTasks');
  await goalTitleField(page).press('Enter');
  await closeGoalScreen(page, testInfo);
  await expect(goalCards(page)).toHaveCount(1);

  for (const title of ['Relire le PRD', 'Valider les maquettes']) {
    await createTask(page, testInfo, { title });
    await rowOf(page, title).getByRole('button', { name: title, exact: true }).click();
    const fiche = detailOf(page);
    await fiche.getByRole('switch', { name: 'Rattacher à mon objectif' }).click();
    await expect(fiche.getByText('Rattachée : Finaliser le PRD CircleTasks')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(fiche).toHaveCount(0);
  }
  await expect(goalCards(page).first()).toContainText('0/2');
  await rowOf(page, 'Relire le PRD').getByRole('checkbox', { name: 'Terminer : Relire le PRD' }).click();
  await expect(goalCards(page).first()).toContainText('1/2');
});
