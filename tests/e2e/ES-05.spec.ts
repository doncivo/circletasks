import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { addProject, backToToday, detailOf, filterPill, openSpacesScreen, setTaskProject } from './helpers/spaces';
import { createTask, isPhone, rowOf } from './helpers/today';

/**
 * ES-05 — Je déplace un élément d'un espace ou projet à l'autre.
 *
 * Couverture : « Déplacer » du mode édition vers « Perso · aucun projet » (2 tâches, une action, message « 2 tâches déplacées dans
 * Perso » 5 s, Annuler restaure espace ET projet d'origine, Ctrl+Z sur PC) ; sous le filtre Pro les tâches déplacées quittent la liste
 * aussitôt ; depuis la fiche, choisir l'espace Perso remet le projet à « aucun » (PC : pastilles de la fiche, iPhone : feuille
 * « Modifier »). Le formulaire de routine et la conservation de la date, des rappels et de l'objectif : Vitest. `pc` et `iphone`.
 */
test.describe('ES-05 — déplacer un élément', () => {
  const toggle = (page: Page) => page.getByRole('button', { name: 'Mode édition' });
  const status = (page: Page) => page.getByRole('status');
  const subtitle = (page: Page, title: string) => rowOf(page, title).locator('.ct-list-row__subtitle, .ct-list-row__meta');

  async function seed(page: Page, testInfo: { project: { name: string } }): Promise<[string, string]> {
    await openApp(page);
    await openSpacesScreen(page);
    await addProject(page, 'Pro', 'Mission client');
    await backToToday(page);
    const a = `Facture ${testInfo.project.name}`;
    const b = `Devis ${testInfo.project.name}`;
    await createTask(page, testInfo, { title: a });
    await createTask(page, testInfo, { title: b });
    await setTaskProject(page, testInfo, a, 'Mission client');
    return [a, b];
  }

  test('« Perso · aucun projet » déplace les deux tâches en une action ; Annuler restaure espace et projet (critères 4, 5)', async ({ page }, testInfo) => {
    const [a, b] = await seed(page, testInfo);
    await toggle(page).click();
    await page.getByRole('button', { name: `Sélectionner : ${a}` }).click();
    await page.getByRole('button', { name: `Sélectionner : ${b}` }).click();
    await page.getByRole('toolbar', { name: 'Actions sur la sélection' }).getByRole('button', { name: 'Déplacer' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Déplacer vers un espace ou un projet' });
    await expect(dialog.getByRole('button', { name: 'Pro · Mission client' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Perso · aucun projet' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Perso · aucun projet' }).click();
    await expect(status(page)).toContainText('2 tâches déplacées dans Perso');
    await toggle(page).click();
    await expect(subtitle(page, a)).toHaveText('Perso');
    await expect(subtitle(page, b)).toHaveText('Perso');
    await status(page).getByRole('button', { name: 'Annuler' }).click();
    await expect(subtitle(page, a)).toHaveText('Pro');
    await expect(subtitle(page, b)).toHaveText('Pro');
    // Le projet d'origine est revenu avec l'espace.
    await rowOf(page, a).getByRole('button', { name: a, exact: true }).click();
    await expect(detailOf(page).getByText('Mission client').first()).toBeVisible();
  });

  test('sous le filtre Pro, les tâches déplacées dans Perso quittent la liste aussitôt ; Ctrl+Z les rend (critères 5, 6)', async ({ page }, testInfo) => {
    const [a, b] = await seed(page, testInfo);
    await filterPill(page, 'Pro').click();
    await toggle(page).click();
    await page.getByRole('button', { name: `Sélectionner : ${a}` }).click();
    await page.getByRole('toolbar', { name: 'Actions sur la sélection' }).getByRole('button', { name: 'Déplacer' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Perso · aucun projet' }).click();
    await expect(rowOf(page, a)).toHaveCount(0);
    await expect(rowOf(page, b)).toBeVisible();
    await expect(status(page)).toContainText(`« ${a} » déplacée dans Perso`);
    if (isPhone(testInfo)) {
      await status(page).getByRole('button', { name: 'Annuler' }).click();
    } else {
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Control+z');
    }
    await expect(rowOf(page, a)).toBeVisible();
  });

  test('depuis la fiche, choisir l’espace Perso remet le projet à « aucun » (critère 1)', async ({ page }, testInfo) => {
    const [a] = await seed(page, testInfo);
    await rowOf(page, a).getByRole('button', { name: a, exact: true }).click();
    const fiche = detailOf(page);
    if (isPhone(testInfo)) {
      await fiche.getByRole('button', { name: 'Modifier' }).click();
      const edit = page.getByRole('dialog', { name: 'Modifier la tâche' });
      await edit.getByRole('button', { name: 'Perso', exact: true }).click();
      await expect(edit.getByText('Projet : aucun')).toBeVisible();
      await edit.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(edit).toHaveCount(0);
      await expect(fiche.getByText('Perso')).toBeVisible();
    } else {
      await fiche.getByRole('button', { name: /^Espace de la tâche : Pro/ }).click();
      await fiche.getByRole('group', { name: 'Espace de la tâche' }).getByRole('button', { name: 'Perso' }).click();
      // Perso n'a aucun projet : la ligne affiche « Aucun ».
      await expect(fiche.getByRole('combobox', { name: 'Projet' })).toHaveCount(0);
    }
    await expect(status(page)).toContainText(`« ${a} » déplacée dans Perso`);
    await fiche.getByRole('button', { name: 'Fermer' }).click();
    await expect(subtitle(page, a)).toHaveText('Perso');
  });

  test('depuis la fiche PC, un autre projet du même espace ne change que le projet (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'liste « Projet » éditable dans la fiche : PC (iPhone : feuille « Modifier », couvert par ES-04)');
    const [a] = await seed(page, testInfo);
    await openSpacesScreen(page);
    await addProject(page, 'Pro', 'Refonte site');
    await backToToday(page);
    await rowOf(page, a).getByRole('button', { name: a, exact: true }).click();
    const fiche = detailOf(page);
    await fiche.getByRole('combobox', { name: 'Projet' }).selectOption({ label: 'Refonte site' });
    await expect(fiche.getByText('Projet : Refonte site')).toBeVisible();
    await expect(status(page)).toContainText(`« ${a} » déplacée dans Pro · Refonte site`);
    await expect(fiche.getByRole('button', { name: /^Espace de la tâche : Pro/ })).toBeVisible();
  });
});
