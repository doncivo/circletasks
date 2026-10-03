import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { browserWeek, closeGoalScreen, goalCards, goalSections, goalTitleField, insertGoals, openGoalScreen } from './helpers/goals';
import { filterPill } from './helpers/spaces';
import { isPhone, todayTab } from './helpers/today';
import { weekTab } from './helpers/week';

/**
 * OB-02 — J'épingle l'objectif en haut de ma liste. Parcours clé 9 (épinglage, filtre d'espace). Exécuté sur `pc` et `iphone`.
 */
test.describe('OB-02 — épingler l’objectif en tête d’Aujourd’hui', () => {
  test('un nouvel objectif est épinglé : l’encadré apparaît ; l’interrupteur le retire (critères 1, 2 et 8)', async ({ page }, testInfo) => {
    await openApp(page);
    await openGoalScreen(page);
    await goalTitleField(page).fill('Finaliser le PRD CircleTasks');
    await goalTitleField(page).press('Enter');
    await expect(goalSections(page)).toHaveCount(1);
    const pin = page.getByRole('switch', { name: 'Épinglé en haut de la liste' });
    await expect(pin).toHaveAttribute('aria-checked', 'true');

    await closeGoalScreen(page, testInfo);
    await expect(goalCards(page)).toHaveCount(1);
    await expect(goalCards(page).first()).toContainText('Objectif de la semaine');
    await expect(goalCards(page).first()).toContainText('Finaliser le PRD CircleTasks');

    // Désépingler : l'encadré disparaît d'Aujourd'hui, l'objectif reste dans l'écran Objectif.
    await openGoalScreen(page);
    await page.getByRole('switch', { name: 'Épinglé en haut de la liste' }).click();
    await expect(page.getByRole('switch', { name: 'Épinglé en haut de la liste' })).toHaveAttribute('aria-checked', 'false');
    await closeGoalScreen(page, testInfo);
    await expect(goalCards(page)).toHaveCount(0);
    await openGoalScreen(page);
    await expect(goalTitleField(page)).toHaveValue('Finaliser le PRD CircleTasks');
  });

  test('un encadré par objectif épinglé ; le filtre d’espace s’applique (critères 5 et 9)', async ({ page }) => {
    await openApp(page);
    const monday = await browserWeek(page);
    await insertGoals(page, [
      { title: 'Objectif Pro', weekStart: monday, space: 'pro' },
      { title: 'Objectif Perso', weekStart: monday, space: 'perso' },
      { title: 'Objectif non épinglé', weekStart: monday, space: 'pro', pinned: false },
    ]);
    await weekTab(page).click();
    await todayTab(page).click();
    await expect(goalCards(page)).toHaveCount(2);
    await expect(goalCards(page).nth(0)).toContainText('Objectif Pro');
    await expect(goalCards(page).nth(1)).toContainText('Objectif Perso');
    await expect(page.getByText('+1')).toHaveCount(0);

    await filterPill(page, 'Pro').click();
    await expect(goalCards(page)).toHaveCount(1);
    await expect(goalCards(page)).toContainText('Objectif Pro');
    await filterPill(page, 'Perso').click();
    await expect(goalCards(page)).toHaveCount(1);
    await expect(goalCards(page)).toContainText('Objectif Perso');
    await filterPill(page, 'Tout').click();
    await expect(goalCards(page)).toHaveCount(2);
  });

  test('toucher l’encadré ouvre l’écran Objectif (critère 4)', async ({ page }) => {
    await openApp(page);
    await insertGoals(page, [{ title: 'Objectif Pro', weekStart: await browserWeek(page) }]);
    await weekTab(page).click();
    await todayTab(page).click();
    await goalCards(page).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Objectif', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Objectif de la semaine' })).toHaveValue('Objectif Pro');
  });

  test('l’encadré de la semaine passée n’est plus affiché (critère 3)', async ({ page }) => {
    await openApp(page);
    await insertGoals(page, [{ title: 'Objectif de la semaine passée', weekStart: await browserWeek(page, -1) }]);
    await weekTab(page).click();
    await todayTab(page).click();
    await expect(goalCards(page)).toHaveCount(0);
  });

  test('le bandeau « OBJECTIF » surmonte les colonnes de la Semaine PC (critère 6)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Bandeau de la Semaine : PC seulement');
    await openApp(page);
    await insertGoals(page, [{ title: 'Objectif Pro', weekStart: await browserWeek(page) }]);
    await weekTab(page).click();
    const banner = page.getByRole('group', { name: 'Objectifs de la semaine' });
    await expect(banner).toContainText('OBJECTIF');
    await expect(banner).toContainText('Objectif Pro');
    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(banner).toHaveCount(0);
  });
});
