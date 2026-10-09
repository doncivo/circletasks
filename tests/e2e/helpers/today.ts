import { expect, type Locator, type Page } from '@playwright/test';
import { openApp, waitForScreenLoaded } from './app';
import { setWheels, typeDate } from './schedule';

/** Aides e2e d'Aujourd'hui (A-01 à A-09), communes aux projets `pc` et `iphone`. */

export type Project = 'pc' | 'iphone';

export const isPhone = (testInfo: { project: { name: string } }): boolean => testInfo.project.name === 'iphone';

/** Crée une tâche du jour (ou datée) depuis le contrôle de l'appareil : saisie en ligne (PC) ou feuille « Nouvelle tâche » (iPhone). */
export async function createTask(
  page: Page,
  testInfo: { project: { name: string } },
  input: { title: string; date?: string; time?: string },
): Promise<void> {
  if (isPhone(testInfo)) {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(input.title);
    await setWheels(page, dialog, { ...(input.date ? { date: input.date } : {}), ...(input.time ? { time: input.time } : {}) });
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }
  const field = page.getByLabel('Nouvelle tâche');
  await field.fill(input.title);
  if (input.date || input.time) await typeDate(page, [input.date, input.time].filter(Boolean).join(' '));
  await field.press('Enter');
  await expect(field).toHaveValue('');
}

/** Ligne de liste d'une tâche, par son titre exact. */
export function rowOf(page: Page, title: string): Locator {
  return page.locator('.ct-list-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
}

/** Titres des lignes de la liste du jour, dans l'ordre d'affichage. */
export async function listTitles(page: Page): Promise<string[]> {
  return page.locator('.ct-today__list .ct-list-row__title').allTextContents();
}

/**
 * Lignes du jour après « Commencer » avec les données d'exemple. La routine « Revue de la semaine » (Pro) a lieu le vendredi : ce jour-là
 * elle s'ajoute avant les tâches sans heure ; le test ne dépend pas du jour où il tourne (fuseau de la suite : Europe/Paris).
 */
export function sampleTodayTitles(now: Date = new Date()): string[] {
  const titles = ['Marcher 20 minutes', 'Préparer la réunion d’équipe', 'Faire les courses', 'Envoyer la facture du mois'];
  const friday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'Europe/Paris' }).format(now) === 'Fri';
  if (friday) titles.splice(3, 0, 'Revue de la semaine');
  return titles;
}

export const todayTab =(page: Page): Locator => page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true });

export async function openToday(page: Page): Promise<void> {
  await openApp(page);
  await waitForScreenLoaded(page, 'taskdetail');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
