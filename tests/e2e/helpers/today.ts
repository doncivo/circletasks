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
    await dialog.getByRole('button', { name: 'Ajouter la tâche' }).click();
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

export const todayTab = (page: Page): Locator => page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true });

export async function openToday(page: Page): Promise<void> {
  await openApp(page);
  await waitForScreenLoaded(page, 'taskdetail');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/*
 * UI-REFONTE-02 : sur iPhone, l'en-tête d'Aujourd'hui ne garde que Rechercher et « Plus d’options » ; Un jour, Objectif de la semaine,
 * Rapport mensuel, Vue compacte et Mode édition sont des entrées de ce menu. Sur PC, les boutons de l'écran restent.
 */
const moreButton = (page: Page): Locator => page.getByRole('button', { name: 'Plus d’options' });

/** Ouvre le menu « Plus d’options » (iPhone) et renvoie sa feuille. */
export async function openMoreMenu(page: Page): Promise<Locator> {
  await moreButton(page).click();
  const menu = page.getByRole('dialog', { name: 'Plus d’options' });
  await expect(menu).toBeVisible();
  return menu;
}

/** Commande d'en-tête d'Aujourd'hui : bouton de l'écran (PC) ou entrée du menu « Plus d’options » (iPhone). */
export async function clickTodayHeaderAction(page: Page, name: 'Un jour' | 'Objectif de la semaine' | 'Rapport mensuel'): Promise<void> {
  if (await moreButton(page).isVisible()) {
    const menu = await openMoreMenu(page);
    await menu.getByRole('menuitem', { name: name === 'Un jour' ? /^Un jour/ : name }).click();
    await expect(menu).toBeHidden();
    return;
  }
  await page.getByRole('button', { name: name === 'Un jour' ? /^Un jour/ : name, exact: name !== 'Un jour' }).click();
}

/** Interrupteur « Mode édition » ou « Vue compacte » : bouton de l'écran (PC) ou entrée du menu (iPhone). */
export async function toggleTodayView(page: Page, name: 'Mode édition' | 'Vue compacte'): Promise<void> {
  if (await moreButton(page).isVisible()) {
    const menu = await openMoreMenu(page);
    await menu.getByRole('menuitemcheckbox', { name }).click();
    await expect(menu).toBeHidden();
    return;
  }
  await page.getByRole('button', { name }).click();
}

/** État de l'interrupteur (`aria-pressed` du bouton PC, `aria-checked` de l'entrée du menu iPhone, menu refermé). */
export async function todayViewState(page: Page, name: 'Mode édition' | 'Vue compacte'): Promise<boolean> {
  if (await moreButton(page).isVisible()) {
    const menu = await openMoreMenu(page);
    const checked = (await menu.getByRole('menuitemcheckbox', { name }).getAttribute('aria-checked')) === 'true';
    await menu.getByRole('button', { name: 'Fermer' }).click();
    await expect(menu).toBeHidden();
    return checked;
  }
  return (await page.getByRole('button', { name }).getAttribute('aria-pressed')) === 'true';
}
