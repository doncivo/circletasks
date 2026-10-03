import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { attachTasks, goalCards, insertGoals } from './helpers/goals';
import { filterPill } from './helpers/spaces';
import { rowOf, todayTab } from './helpers/today';
import { insertTasks, weekTab } from './helpers/week';

/**
 * OB-05 — Je reconduis un objectif non atteint. Parcours clé 9 (reconduction le lundi suivant, QB-14). Le navigateur est calé sur
 * le lundi 5 octobre 2026 (10:00, Europe/Paris) : l'objectif de la semaine du 28 septembre est échu. Exécuté sur `pc` et `iphone`.
 */
test.describe('OB-05 — reconduire un objectif non atteint', () => {
  const reviews = (page: Page) => page.getByRole('list', { name: 'Objectifs à réviser' });
  const reload = async (page: Page): Promise<void> => {
    await weekTab(page).click();
    await todayTab(page).click();
  };

  async function seed(page: Page, now = '2026-10-05T08:00:00Z'): Promise<void> {
    await page.clock.setFixedTime(new Date(now));
    await openApp(page);
    await insertGoals(page, [{ title: 'Finaliser le PRD CircleTasks', weekStart: '2026-09-28' }]);
    await insertTasks(page, [
      { title: 'Relire le brief', date: '2026-09-29', done: true },
      { title: 'Écrire le plan', date: '2026-10-02', time: '09:00' },
      { title: 'Valider la maquette', date: '2026-10-07' },
    ]);
    await attachTasks(page, 'Finaliser le PRD CircleTasks', ['Relire le brief', 'Écrire le plan', 'Valider la maquette']);
    await reload(page);
  }

  test('le lundi suivant, la carte propose Reconduire ou Clore (critère 1)', async ({ page }) => {
    await seed(page);
    await expect(reviews(page)).toContainText('Objectif non atteint : Finaliser le PRD CircleTasks');
    await expect(reviews(page).getByRole('button', { name: /^Reconduire/ })).toBeVisible();
    await expect(reviews(page).getByRole('button', { name: /^Clore/ })).toBeVisible();
    await expect(goalCards(page)).toHaveCount(0);
  });

  test('Reconduire : nouvel objectif épinglé, tâches non faites reportées au jour de réponse, annulable (critères 3, 4 et 7)', async ({ page }) => {
    await seed(page);
    await reviews(page).getByRole('button', { name: /^Reconduire/ }).click();
    await expect(reviews(page)).toHaveCount(0);
    await expect(goalCards(page)).toHaveCount(1);
    await expect(goalCards(page).first()).toContainText('Finaliser le PRD CircleTasks');
    // La tâche restée dans le passé prend la date d'aujourd'hui (QB-14), heure conservée ; l'autre garde sa date.
    await expect(rowOf(page, 'Écrire le plan')).toContainText('09:00');
    await expect(goalCards(page).first()).toContainText('0/2');
    // « Annuler » rétablit la carte, l'ancien objectif et la date d'origine.
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(reviews(page)).toContainText('Objectif non atteint : Finaliser le PRD CircleTasks');
    await expect(goalCards(page)).toHaveCount(0);
    await expect(rowOf(page, 'Écrire le plan')).toHaveCount(0);
  });

  test('Clore : la carte disparaît, aucun nouvel encadré, les tâches gardent leur date (critère 5)', async ({ page }) => {
    await seed(page);
    await reviews(page).getByRole('button', { name: /^Clore/ }).click();
    await expect(reviews(page)).toHaveCount(0);
    await expect(goalCards(page)).toHaveCount(0);
    await expect(rowOf(page, 'Écrire le plan')).toHaveCount(0);
    await reload(page);
    await expect(reviews(page)).toHaveCount(0);
  });

  test('la carte reste proposée le mercredi, filtrée par espace (critère 2)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-07T08:00:00Z'));
    await openApp(page);
    await insertGoals(page, [
      { title: 'Objectif Pro', weekStart: '2026-09-28', space: 'pro' },
      { title: 'Objectif Perso', weekStart: '2026-09-28', space: 'perso' },
      { title: 'Objectif atteint', weekStart: '2026-09-28', status: 'achieved' },
    ]);
    await reload(page);
    await expect(reviews(page).getByRole('listitem')).toHaveCount(2);
    await filterPill(page, 'Perso').click();
    await expect(reviews(page).getByRole('listitem')).toHaveCount(1);
    await expect(reviews(page)).toContainText('Objectif Perso');
    await filterPill(page, 'Tout').click();
    await expect(reviews(page).getByRole('listitem')).toHaveCount(2);
  });
});
