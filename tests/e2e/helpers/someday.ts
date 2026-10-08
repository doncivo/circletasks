import { expect, type Locator, type Page } from '@playwright/test';
import { waitForScreenLoaded } from './app';
import { isPhone } from './today';

/** Aides e2e de « Un jour » (SD-01 à SD-04, S-06), communes aux projets `pc` et `iphone`. */

export interface DirectSomeday {
  readonly title: string;
  readonly space?: 'pro' | 'perso';
  /** Nom d'un projet déjà créé (même espace). */
  readonly project?: string;
}

/** Insère des tâches « Un jour » en base par la prise de test (navigateur de développement) ; dans l'ordre donné, la première en tête. */
export async function insertSomeday(page: Page, items: readonly DirectSomeday[]): Promise<void> {
  await page.evaluate(async (tasks) => {
    const hooks = window.__ctTest;
    if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
    let order = 0;
    for (const item of tasks) {
      order += 1;
      const n = String(order).padStart(12, '0');
      const stamp = `00000000000${String(order).padStart(4, '0')}-0000-e2e`;
      await hooks.execute(
        `INSERT INTO task (id, space_id, project_id, title, date, time, status, sort_order, someday, created_at, updated_at, device_id, hlc)
         VALUES (?, ?, ${item.project ? '(SELECT id FROM project WHERE name = ? LIMIT 1)' : 'NULL'}, ?, NULL, NULL, 'todo', ?, 1,
                 '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 'e2e', ?)`,
        [
          `32000000-0000-4000-8000-${n}`,
          item.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
          ...(item.project ? [item.project] : []),
          item.title,
          order,
          stamp,
        ],
      );
    }
  }, items);
}

/** Icône horloge d'Aujourd'hui (nom accessible « Un jour » ou « Un jour, 6 tâches »). */
export const somedayButton = (page: Page): Locator => page.getByRole('button', { name: /^Un jour(,|$)/ });

/** Liste des tâches de « Un jour » (écran iPhone ou panneau PC). */
export const somedayList = (page: Page): Locator => page.getByRole('list', { name: 'Tâches de « Un jour »' });

/** Écran « Un jour » (iPhone) ou son panneau (PC) : zone où chercher les commandes qu'Aujourd'hui affiche aussi (vue compacte, mode édition). */
export const somedayPane = (page: Page): Locator => page.locator('.ct-someday, .ct-someday-panel');

/** Titres des lignes de « Un jour », dans l'ordre affiché. */
export async function somedayTitles(page: Page): Promise<string[]> {
  return somedayList(page).locator('.ct-list-row__title').allTextContents();
}

/** Ouvre « Un jour » depuis Aujourd'hui : écran plein (iPhone) ou panneau à droite (PC). */
export async function openSomeday(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  await waitForScreenLoaded(page, 'somedayscreen');
  await somedayButton(page).click();
  if (isPhone(testInfo)) await expect(page.getByRole('heading', { level: 1, name: 'Un jour' })).toBeVisible();
  else await expect(page.getByRole('complementary', { name: 'Un jour' })).toBeVisible();
}

/** Ferme « Un jour » : « Retour » (iPhone) ou « Fermer le panneau » (PC). */
export async function closeSomeday(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Un jour' })).toBeHidden();
  } else {
    await page.getByRole('button', { name: 'Fermer le panneau' }).click();
    await expect(page.getByRole('complementary', { name: 'Un jour' })).toBeHidden();
  }
}

/** Champ d'ajout sans date : sur PC, le bouton « + Ajouter à « Un jour » » le déplie d'abord. */
export async function addToSomeday(page: Page, title: string): Promise<void> {
  const field = page.getByRole('combobox', { name: 'Nouvelle tâche sans date' });
  if (!(await field.isVisible())) await page.getByRole('button', { name: '+ Ajouter à « Un jour »' }).click();
  await field.fill(title);
  await field.press('Enter');
  await expect(field).toHaveValue('');
  await expect(somedayList(page).getByRole('button', { name: title, exact: true })).toBeVisible();
}
