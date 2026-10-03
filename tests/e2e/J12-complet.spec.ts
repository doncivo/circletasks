import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { closeGoalScreen, goalCards, goalTitleField, openGoalScreen } from './helpers/goals';
import { addIsoDays } from './helpers/schedule';
import { closeSomeday, openSomeday, somedayButton } from './helpers/someday';
import { detailOf } from './helpers/spaces';
import { createTask, isPhone, rowOf, todayTab } from './helpers/today';
import { browserMonday, dayOf, openWeek } from './helpers/week';

/**
 * Parcours clé 12 complet (PRD section 8) : objectif + « Un jour » + glisser vers la Semaine, dans un seul scénario.
 * Une tâche rattachée à l'objectif part dans « Un jour » (l'avancement ne bouge pas), puis est planifiée
 * (PC : glisser vers un jour de la Semaine ; iPhone : « Planifier »), terminée : l'encadré passe à 1/1.
 */
async function mouseDragTo(page: Page, card: Locator, to: Locator): Promise<void> {
  const from = await card.boundingBox();
  const target = await to.boundingBox();
  if (!from || !target) throw new Error('élément introuvable à l’écran');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 12, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height - 8, 120), { steps: 12 });
  await page.mouse.up();
}

test('parcours 12 complet : objectif, tâche rattachée envoyée dans « Un jour », planifiée, terminée', async ({ page }, testInfo) => {
  await openApp(page);
  await openGoalScreen(page);
  await goalTitleField(page).fill('Renouveler mes papiers');
  await goalTitleField(page).press('Enter');
  await closeGoalScreen(page, testInfo);
  await expect(goalCards(page)).toHaveCount(1);

  await createTask(page, testInfo, { title: 'Déposer le dossier' });
  await rowOf(page, 'Déposer le dossier').getByRole('button', { name: 'Déposer le dossier', exact: true }).click();
  await detailOf(page).getByRole('switch', { name: 'Rattacher à mon objectif' }).click();
  await expect(detailOf(page).getByText('Rattachée : Renouveler mes papiers')).toBeVisible();
  await expect(goalCards(page).first()).toContainText('0/1');

  // Envoyée dans « Un jour » : rattachement et avancement inchangés.
  await detailOf(page).getByRole('button', { name: 'Un jour' }).click();
  await expect(page.getByRole('status')).toContainText('« Déposer le dossier » mise dans « Un jour »');
  await page.keyboard.press('Escape');
  await expect(rowOf(page, 'Déposer le dossier')).toHaveCount(0);
  await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
  await expect(goalCards(page).first()).toContainText('0/1');

  // Planification.
  const target = addIsoDays(await browserMonday(page), 3);
  if (isPhone(testInfo)) {
    await openSomeday(page, testInfo);
    await page.getByRole('button', { name: 'Déposer le dossier', exact: true }).click();
    await page.getByRole('button', { name: 'Planifier aujourd’hui : Déposer le dossier' }).click();
    await closeSomeday(page, testInfo);
    await expect(rowOf(page, 'Déposer le dossier')).toBeVisible();
  } else {
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    const panel = page.getByRole('complementary', { name: 'Un jour' });
    const card = panel.locator('[data-drag-id]').filter({ has: page.getByRole('button', { name: 'Déposer le dossier', exact: true }) });
    await mouseDragTo(page, card, dayOf(page, target));
    await expect(dayOf(page, target)).toContainText('Déposer le dossier');
    await page.getByRole('button', { name: 'Fermer le panneau' }).click();
    await todayTab(page).click();
    await expect(goalCards(page).first()).toContainText('0/1');
    return;
  }
  await expect(goalCards(page).first()).toContainText('0/1');
  await rowOf(page, 'Déposer le dossier').getByRole('checkbox', { name: 'Terminer : Déposer le dossier' }).click();
  await expect(goalCards(page).first()).toContainText('1/1');
});
