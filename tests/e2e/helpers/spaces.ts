import { expect, type Locator, type Page } from '@playwright/test';
import { waitForScreenLoaded } from './app';
import { isPhone, rowOf } from './today';

/** Aides e2e des espaces et projets (ES-01 à ES-05), communes aux projets `pc` et `iphone`. */

/** Filtre Pro / Perso / Tout. */
export const filterGroup = (page: Page): Locator => page.getByRole('group', { name: 'Filtre d’espace' });
export const filterPill = (page: Page, name: 'Pro' | 'Perso' | 'Tout' | string): Locator => filterGroup(page).getByRole('button', { name, exact: true });

/** Menu « Projet : tous » à droite des pastilles (QB-15). */
export const projectFilterMenu = (page: Page): Locator => page.getByRole('combobox', { name: 'Filtre de projet' });

/** Fiche détail (panneau PC ou feuille iPhone). */
export const detailOf = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));

/** Ouvre Réglages › Espaces et projets. */
export async function openSpacesScreen(page: Page): Promise<void> {
  await waitForScreenLoaded(page, 'settingsscreen');
  await waitForScreenLoaded(page, 'spacesscreen');
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  // L'onglet Réglages rouvre son dernier écran : l'écran Espaces et projets peut déjà être affiché.
  const row = page.getByRole('button', { name: /^Espaces et projets :/ });
  const heading = page.getByRole('heading', { name: 'Espaces et projets' });
  await expect(row.or(heading)).toBeVisible();
  if (await row.isVisible()) await row.click();
  await expect(page.getByRole('heading', { name: 'Espaces et projets' })).toBeVisible();
}

/** Zone « Projets » d'un espace dans l'écran Espaces et projets. */
export const projectsOf = (page: Page, space: string): Locator => page.getByRole('region', { name: `Projets de l’espace ${space}` });

/** Noms des projets actifs d'un espace, dans l'ordre affiché. */
export async function activeProjectNames(page: Page, space: string): Promise<string[]> {
  return projectsOf(page, space).locator('.ct-projects__list .ct-projects__name').allTextContents();
}

/** Ajoute un projet depuis l'écran Espaces et projets (déjà ouvert). */
export async function addProject(page: Page, space: string, name: string, color?: string): Promise<void> {
  const zone = projectsOf(page, space);
  await zone.getByRole('button', { name: 'Ajouter un projet' }).click();
  await zone.getByLabel('Nom du projet').fill(name);
  if (color) await zone.getByRole('radio', { name: color }).click();
  await zone.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(zone.getByRole('list').getByText(name, { exact: true })).toBeVisible();
}

/** Retourne à Aujourd'hui par l'onglet « Tâches ». */
export async function backToToday(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
}

/**
 * Range une tâche déjà créée dans un projet de son espace : liste « Projet » de la fiche (PC) ou feuille « Modifier » (iPhone).
 * Ferme la fiche ensuite.
 */
export async function setTaskProject(page: Page, testInfo: { project: { name: string } }, title: string, projectName: string): Promise<void> {
  await rowOf(page, title).getByRole('button', { name: title, exact: true }).click();
  const fiche = detailOf(page);
  if (isPhone(testInfo)) {
    await fiche.getByRole('button', { name: 'Modifier' }).click();
    const edit = page.getByRole('dialog', { name: 'Modifier la tâche' });
    await edit.getByRole('combobox', { name: 'Projet' }).selectOption({ label: projectName });
    await edit.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(edit).toHaveCount(0);
    await expect(fiche.getByText(projectName)).toBeVisible();
    await fiche.getByRole('button', { name: 'Fermer' }).click();
  } else {
    await fiche.getByRole('button', { name: /^Projet : / }).click();
    await fiche.getByRole('combobox', { name: 'Projet' }).selectOption({ label: projectName });
    await expect(fiche.getByRole('button', { name: `Projet : ${projectName}` })).toBeVisible();
    await fiche.getByRole('button', { name: 'Fermer' }).click();
  }
}
