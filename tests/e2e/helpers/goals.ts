import { expect, type Locator, type Page } from '@playwright/test';
import { addIsoDays, browserToday } from './schedule';
import { mondayOf } from './week';
import { waitForScreenLoaded } from './app';

/** Aides e2e de l'objectif de la semaine (OB-01 à OB-06), communes aux projets `pc` et `iphone`. */

export interface DirectGoal {
  readonly title: string;
  /** Lundi de la semaine visée ('YYYY-MM-DD'). */
  readonly weekStart: string;
  readonly space?: 'pro' | 'perso';
  /** Épinglé (défaut : oui). */
  readonly pinned?: boolean;
  readonly status?: 'open' | 'achieved' | 'closed';
  /** Titre de l'objectif reconduit (déjà inséré) : renseigne `carried_from_id`. */
  readonly carriedFrom?: string;
}

/** Lundi de la semaine courante du navigateur et celui de la semaine `offset` semaines plus tard (négatif : avant). */
export async function browserWeek(page: Page, offset = 0): Promise<string> {
  return addIsoDays(mondayOf(await browserToday(page)), offset * 7);
}

/** Insère des objectifs en base par la prise de test (navigateur de développement) ; à appeler avant d'ouvrir l'écran concerné. */
export async function insertGoals(page: Page, items: readonly DirectGoal[]): Promise<void> {
  await page.evaluate(async (goals) => {
    const hooks = window.__ctTest;
    if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
    const base = Date.now();
    let order = 0;
    for (const item of goals) {
      order += 1;
      const stamp = `${String(base + order).padStart(15, '0')}-0000-e2e`;
      const at = new Date(base + order).toISOString();
      const parent = item.carriedFrom ? `(SELECT id FROM goal WHERE title = '${item.carriedFrom.replace(/'/g, "''")}' LIMIT 1)` : 'NULL';
      await hooks.execute(
        `INSERT INTO goal (id, space_id, week_start, title, icon, pinned, status, carried_from_id, created_at, updated_at, device_id, hlc)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ${parent}, ?, ?, 'e2e', ?)`,
        [
          crypto.randomUUID(),
          item.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
          item.weekStart,
          item.title,
          item.pinned === false ? 0 : 1,
          item.status ?? 'open',
          at,
          at,
          stamp,
        ],
      );
    }
  }, items);
}

/** Rattache une tâche (par son titre) à un objectif (par son titre) directement en base. */
export async function attachTasks(page: Page, goalTitle: string, taskTitles: readonly string[]): Promise<void> {
  await page.evaluate(
    async ([goal, titles]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente');
      for (const title of titles as string[]) {
        await hooks.execute('UPDATE task SET goal_id = (SELECT id FROM goal WHERE title = ? LIMIT 1) WHERE title = ?', [goal as string, title]);
      }
    },
    [goalTitle, taskTitles] as const,
  );
}

/** Icône cible en haut d'Aujourd'hui. */
export const goalButton = (page: Page): Locator => page.getByRole('button', { name: 'Objectif de la semaine', exact: true });

/** Écran Objectif : écran plein (iPhone) ou panneau à droite (PC). */
export const goalScreen = (page: Page): Locator => page.getByRole('heading', { level: 1, name: 'Objectif', exact: true });

/** Ouvre l'écran Objectif depuis Aujourd'hui par l'icône cible. */
export async function openGoalScreen(page: Page): Promise<void> {
  await waitForScreenLoaded(page, 'goalsscreen');
  await goalButton(page).click();
  await expect(goalScreen(page)).toBeVisible();
}

/** Ferme l'écran Objectif : « Retour » (iPhone) ou bouton de fermeture du panneau (PC). */
export async function closeGoalScreen(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  await page.getByRole('button', { name: testInfo.project.name === 'iphone' ? 'Retour' : 'Fermer' }).click();
  await expect(goalScreen(page)).toHaveCount(0);
}

/** Sections d'objectif de l'écran Objectif (une par objectif ou brouillon). */
export const goalSections = (page: Page): Locator => page.locator('.ct-goal');

/** Champ titre de la n-ième section (1 = première). */
export const goalTitleField = (page: Page, n = 1): Locator =>
  page.getByRole('textbox', { name: n <= 1 ? 'Objectif de la semaine' : `Objectif de la semaine (${n})`, exact: true });

/** Encadrés d'objectif épinglés d'Aujourd'hui. */
export const goalCards = (page: Page): Locator => page.locator('.ct-today-goal');
