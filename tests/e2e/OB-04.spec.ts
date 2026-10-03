import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { attachTasks, browserWeek, closeGoalScreen, goalCards, goalSections, insertGoals, openGoalScreen } from './helpers/goals';
import { browserToday } from './helpers/schedule';
import { rowOf, todayTab } from './helpers/today';
import { insertTasks, weekTab } from './helpers/week';

/**
 * OB-04 — Je vois l'avancement de l'objectif. Parcours clé 9 (avancement « 2/5 », « Marquer atteint »). Exécuté sur `pc` et `iphone`.
 */
test.describe('OB-04 — avancement de l’objectif', () => {
  async function seed(page: Page): Promise<void> {
    await openApp(page);
    const today = await browserToday(page);
    await insertGoals(page, [{ title: 'Finaliser le PRD CircleTasks', weekStart: await browserWeek(page) }]);
    await insertTasks(page, [
      { title: 'Relire les user stories', date: today, done: true },
      { title: 'Valider les maquettes', date: today, done: true },
      { title: 'Mettre à jour CLAUDE.md', date: today },
      { title: 'Préparer le dépôt GitHub', date: today },
      { title: 'Lancer Claude Code', date: today },
    ]);
    await attachTasks(page, 'Finaliser le PRD CircleTasks', ['Relire les user stories', 'Valider les maquettes', 'Mettre à jour CLAUDE.md', 'Préparer le dépôt GitHub', 'Lancer Claude Code']);
    await weekTab(page).click();
    await todayTab(page).click();
    await expect(goalCards(page)).toHaveCount(1);
  }

  test('« 2/5 » dans l’encadré et « 2 faites sur 5 », barre à 40 % dans l’écran Objectif (critère 1)', async ({ page }) => {
    await seed(page);
    await expect(goalCards(page).first()).toContainText('2/5');
    await openGoalScreen(page);
    await expect(page.getByText('2 faites sur 5')).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Avancement de l’objectif' })).toHaveAttribute('aria-valuenow', '40');
  });

  test('terminer une tâche rattachée dans la liste passe à « 3/5 » sans rechargement (critère 2)', async ({ page }, testInfo) => {
    await seed(page);
    await rowOf(page, 'Mettre à jour CLAUDE.md').getByRole('checkbox', { name: 'Terminer : Mettre à jour CLAUDE.md' }).click();
    await expect(goalCards(page).first()).toContainText('3/5');
    await openGoalScreen(page);
    await expect(page.getByText('3 faites sur 5')).toBeVisible();
    // Rouvrir depuis l'écran Objectif redescend le compte, et l'encadré suit.
    await goalSections(page).first().getByRole('checkbox', { name: 'Rouvrir : Mettre à jour CLAUDE.md' }).click();
    await expect(page.getByText('2 faites sur 5')).toBeVisible();
    await closeGoalScreen(page, testInfo);
    await expect(goalCards(page).first()).toContainText('2/5');
  });

  test('« Marquer atteint » : bouton « Rouvrir l’objectif », encadré « Atteint » ; jamais automatique (critères 5 et 6)', async ({ page }, testInfo) => {
    await seed(page);
    await openGoalScreen(page);
    // Toutes les tâches faites : pas de passage automatique à atteint.
    for (const title of ['Mettre à jour CLAUDE.md', 'Préparer le dépôt GitHub', 'Lancer Claude Code']) {
      await goalSections(page).first().getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    }
    await expect(page.getByText('5 faites sur 5')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Marquer atteint' })).toBeVisible();
    await page.getByRole('button', { name: 'Marquer atteint' }).click();
    await expect(page.getByRole('button', { name: 'Rouvrir l’objectif' })).toBeVisible();
    await closeGoalScreen(page, testInfo);
    await expect(goalCards(page).first()).toContainText('Atteint');
    await openGoalScreen(page);
    await page.getByRole('button', { name: 'Rouvrir l’objectif' }).click();
    await expect(page.getByRole('button', { name: 'Marquer atteint' })).toBeVisible();
  });

  test('sans tâche rattachée : « Aucune tâche rattachée » et encadré sans compteur (critère 4)', async ({ page }, testInfo) => {
    await openApp(page);
    await insertGoals(page, [{ title: 'Objectif vide', weekStart: await browserWeek(page) }]);
    await weekTab(page).click();
    await todayTab(page).click();
    await expect(goalCards(page).first()).not.toContainText('/');
    await openGoalScreen(page);
    await expect(page.getByText('Aucune tâche rattachée')).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await closeGoalScreen(page, testInfo);
  });
});
