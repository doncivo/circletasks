import { expect, type Locator, type Page } from '@playwright/test';
import { isPhone } from './today';

/** Aides e2e de la recherche (RC-01 à RC-04), communes aux projets `pc` et `iphone`. */

export const searchDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Recherche' });
export const searchInput = (page: Page): Locator => searchDialog(page).getByRole('searchbox', { name: 'Rechercher' });

/** Ouvre la recherche comme l'utilisateur : Ctrl+K sur PC, loupe de l'en-tête d'Aujourd'hui sur iPhone. */
export async function openSearch(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  if (isPhone(testInfo)) await page.getByRole('button', { name: 'Rechercher', exact: true }).click();
  else await page.keyboard.press('Control+k');
  await expect(searchDialog(page)).toBeVisible();
  await expect(searchInput(page)).toBeFocused();
}

/** Ferme la recherche : « Annuler » sur iPhone, Échap sur PC. */
export async function closeSearch(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  if (isPhone(testInfo)) await searchDialog(page).getByRole('button', { name: 'Annuler' }).click();
  else await page.keyboard.press('Escape');
  await expect(searchDialog(page)).toHaveCount(0);
}

export async function typeSearch(page: Page, text: string): Promise<void> {
  await searchInput(page).fill(text);
}

/** Lignes de résultat, tous groupes confondus. */
export const resultRows = (page: Page): Locator => searchDialog(page).locator('.ct-search__result');

/** En-têtes de groupe (« Tâches · 3 »). */
export async function groupTitles(page: Page): Promise<string[]> {
  return (await searchDialog(page).getByRole('heading', { level: 2 }).allTextContents()).map((text) => text.trim());
}

/** Tâche posée directement en base (indexée par les déclencheurs) : titre, note, espace, date, état. */
export interface SearchTask {
  readonly title: string;
  readonly note?: string;
  readonly space?: 'pro' | 'perso';
  readonly date?: string | null;
  readonly done?: boolean;
  readonly someday?: boolean;
}

let sequence = 0;

export async function insertSearchTasks(page: Page, tasks: readonly SearchTask[]): Promise<void> {
  const offset = sequence;
  sequence += tasks.length;
  await page.evaluate(
    async ([list, base]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
      let order = 0;
      for (const task of list) {
        order += 1;
        const n = String(base + order).padStart(12, '0');
        await hooks.execute(
          `INSERT INTO task (id, space_id, title, note, date, status, done_at, someday, sort_order, created_at, updated_at, device_id, hlc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-09-20T08:00:00.000Z', '2026-09-20T08:00:00.000Z', 'e2e', ?)`,
          [
            `41000000-0000-4000-8000-${n}`,
            task.space === 'perso' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001',
            task.title,
            task.note ?? '',
            task.date === undefined ? '2026-09-23' : task.date,
            task.done ? 'done' : 'todo',
            task.done ? '2026-09-22T08:00:00.000Z' : null,
            task.someday ? 1 : 0,
            order,
            `00000000041${String(base + order).padStart(4, '0')}-0000-e2e`,
          ],
        );
      }
    },
    [tasks, offset] as const,
  );
}

/** Puce de filtre de la recherche, par son nom accessible (« Filtre Type : Tous »). */
export const chipOf = (page: Page, name: string): Locator => searchDialog(page).getByRole('combobox', { name, exact: true });

/** Choisit une valeur dans une puce (liste native : roue sur iPhone, menu au clavier sur PC). */
export async function chooseChip(page: Page, name: string, option: string): Promise<void> {
  await chipOf(page, name).selectOption({ label: option });
}

/** Rattache une tâche (par son titre) à un projet existant (par son nom), directement en base. */
export async function assignProject(page: Page, taskTitle: string, projectName: string): Promise<void> {
  await page.evaluate(
    async ([title, project]) => {
      const hooks = window.__ctTest;
      if (!hooks) throw new Error('prise de test absente (navigateur de développement uniquement)');
      await hooks.execute('UPDATE task SET project_id = (SELECT id FROM project WHERE name = ?) WHERE title = ?', [project ?? '', title ?? '']);
    },
    [taskTitle, projectName] as const,
  );
}

/** Médiane d'une série de mesures (ms) : retenue contre le budget, plus fidèle que le meilleur essai. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Texte des mesures (médiane, maximum, détail) pour l'annotation du test. */
export function describeTimings(label: string, timings: readonly number[]): string {
  return `${label} : médiane ${String(Math.round(median(timings)))} ms, max ${String(Math.round(Math.max(...timings)))} ms (${timings.map((ms) => String(Math.round(ms))).join(' / ')})`;
}
