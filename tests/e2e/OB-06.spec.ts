import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { attachTasks, browserWeek, closeGoalScreen, insertGoals, openGoalScreen } from './helpers/goals';
import { filterPill } from './helpers/spaces';
import { insertTasks } from './helpers/week';

/**
 * OB-06 — Je consulte mes objectifs passés. Parcours clé 9 (historique « SEMAINES PRÉCÉDENTES » dans l'écran Objectif, écart de PRD
 * tranché par Ali : la maquette Objectif.html fait référence). Exécuté sur `pc` et `iphone`.
 */

/** Numéro de semaine ISO d'une date 'YYYY-MM-DD' (jeudi de la semaine). */
function isoWeek(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const thursday = new Date(d.getTime() + (4 - (d.getUTCDay() || 7)) * 86_400_000);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
}

test.describe('OB-06 — objectifs passés', () => {
  const rows = (page: Page) => page.locator('.ct-goal-history__row');
  /** Lignes d'une semaine, par le numéro affiché dans la première colonne (« S38 »). */
  const weekRows = (page: Page, week: number) =>
    rows(page).filter({ has: page.locator('.ct-goal-history__week', { hasText: new RegExp(`^S${String(week)}$`) }) });

  async function seed(page: Page): Promise<{ w1: string; w2: string; w3: string }> {
    await openApp(page);
    const w1 = await browserWeek(page, -1);
    const w2 = await browserWeek(page, -2);
    const w3 = await browserWeek(page, -3);
    await insertGoals(page, [
      { title: 'Trier les papiers administratifs', weekStart: w3, status: 'closed', pinned: false },
      { title: 'Clôturer la paie de septembre', weekStart: w2, status: 'achieved', pinned: false },
      { title: 'Ranger le garage', weekStart: w2, status: 'closed', space: 'perso', pinned: false },
      { title: 'Sans réponse', weekStart: w1, status: 'open', pinned: false },
      { title: 'Reconduit', weekStart: w3, status: 'closed', pinned: false },
      { title: 'Reconduit', weekStart: w2, status: 'achieved', pinned: false, carriedFrom: 'Reconduit' },
    ]);
    await openGoalScreen(page);
    return { w1, w2, w3 };
  }

  test('liste les semaines passées, de la plus récente à la plus ancienne, avec badge et numéro (critères 1, 2 et 4)', async ({ page }) => {
    const { w1, w2, w3 } = await seed(page);
    await expect(page.getByRole('heading', { name: 'SEMAINES PRÉCÉDENTES' })).toBeVisible();
    await expect(rows(page)).toHaveCount(6);
    // La plus récente d'abord : l'objectif resté ouvert (« Non atteint », critère 2).
    await expect(rows(page).first().locator('.ct-goal-history__week')).toHaveText(`S${isoWeek(w1)}`);
    await expect(rows(page).first()).toContainText('Sans réponse');
    await expect(rows(page).first()).toContainText('Non atteint');
    // Trois objectifs de la même semaine : une ligne chacun, même numéro.
    await expect(weekRows(page, isoWeek(w2))).toHaveCount(3);
    await expect(rows(page).filter({ hasText: 'Clôturer la paie de septembre' })).toContainText('Atteint');
    await expect(rows(page).last().locator('.ct-goal-history__week')).toHaveText(`S${isoWeek(w3)}`);
  });

  test('un objectif reconduit affiche « Reconduit en S… » (critère 5)', async ({ page }) => {
    const { w2, w3 } = await seed(page);
    await expect(weekRows(page, isoWeek(w3)).filter({ hasText: 'Reconduit en' })).toContainText(`Reconduit en S${isoWeek(w2)}`);
    await expect(rows(page).filter({ hasText: 'Trier les papiers administratifs' })).not.toContainText('Reconduit en');
  });

  test('toucher une ligne la déplie sur ses tâches avec leur état ; un second toucher la replie (critère 3)', async ({ page }, testInfo) => {
    await openApp(page);
    const w1 = await browserWeek(page, -1);
    await insertGoals(page, [{ title: 'Objectif passé', weekStart: w1, status: 'closed', pinned: false }]);
    await insertTasks(page, [
      { title: 'Tâche faite', date: w1, done: true },
      { title: 'Tâche non faite', date: w1 },
    ]);
    await attachTasks(page, 'Objectif passé', ['Tâche faite', 'Tâche non faite']);
    await openGoalScreen(page);
    const row = rows(page).first();
    await row.click();
    const list = page.getByRole('list', { name: 'Tâches rattachées à l’objectif « Objectif passé »' });
    await expect(list.getByRole('listitem').first()).toContainText('Tâche faite');
    await expect(list.getByRole('listitem').first()).toContainText('Fait');
    await expect(list.getByRole('listitem').nth(1)).toContainText('Non fait');
    await row.click();
    await expect(list).toHaveCount(0);
    await closeGoalScreen(page, testInfo);
  });

  test('le filtre d’espace s’applique à l’historique (critère 6)', async ({ page }, testInfo) => {
    await seed(page);
    await closeGoalScreen(page, testInfo);
    await filterPill(page, 'Perso').click();
    await openGoalScreen(page);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('Ranger le garage');
    await closeGoalScreen(page, testInfo);
    await filterPill(page, 'Tout').click();
    await openGoalScreen(page);
    await expect(rows(page)).toHaveCount(6);
  });

  test('l’historique ne contient pas la semaine en cours', async ({ page }) => {
    await openApp(page);
    await insertGoals(page, [{ title: 'Objectif courant', weekStart: await browserWeek(page) }]);
    await openGoalScreen(page);
    await expect(page.getByRole('heading', { name: 'SEMAINES PRÉCÉDENTES' })).toHaveCount(0);
  });
});
