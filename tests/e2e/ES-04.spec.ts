import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import {
  activeProjectNames,
  addProject,
  backToToday,
  detailOf,
  filterPill,
  openSpacesScreen,
  projectFilterMenu,
  projectsOf,
  setTaskProject,
} from './helpers/spaces';
import { createTask, isPhone, rowOf } from './helpers/today';

/**
 * ES-04 — Je crée des projets dans un espace.
 *
 * Couverture : ajout de « Mission client » (compteur de Réglages 0 → 1), noms refusés (vide, doublon sans casse ; même nom possible
 * dans l'autre espace), couleur par défaut et palette, liste « Projet » (Aucun puis projets actifs de l'espace), archivage et
 * désarchivage, ordre (↓ et Alt+↑), menu « Projet : tous » à droite des pastilles (QB-15) : masqué en « Tout » ou sans projet, filtre
 * des tâches, remis à « tous » en changeant d'espace. Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-04 — projets', () => {
  async function start(page: Page): Promise<void> {
    await openApp(page);
    await openSpacesScreen(page);
  }

  test('ajoute « Mission client » à Pro : il apparaît, le compteur de Réglages passe de 0 à 1 (critères 1, 3)', async ({ page }) => {
    await start(page);
    await addProject(page, 'Pro', 'Mission client');
    expect(await activeProjectNames(page, 'Pro')).toEqual(['Mission client']);
    await expect(projectsOf(page, 'Perso').getByText('Aucun projet pour l’instant.')).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();
    await expect(page.getByRole('button', { name: 'Espaces et projets : Pro (1) · Perso (0)' })).toBeVisible();
  });

  test('nom vide ou en double refusé ; même nom possible dans l’autre espace ; palette de huit couleurs (critères 2, 3)', async ({ page }) => {
    await start(page);
    await addProject(page, 'Pro', 'Mission client');
    const zone = projectsOf(page, 'Pro');
    await zone.getByRole('button', { name: 'Ajouter un projet' }).click();
    await expect(zone.getByRole('radiogroup', { name: 'Couleur du projet' }).getByRole('radio')).toHaveCount(8);
    await expect(zone.getByRole('radio', { name: 'Bleu canard' })).toHaveAttribute('aria-checked', 'true');
    await zone.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(zone.getByRole('alert')).toHaveText('Le nom du projet ne peut pas être vide.');
    await zone.getByLabel('Nom du projet').fill('MISSION CLIENT');
    await zone.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await expect(zone.getByRole('alert')).toHaveText('Un projet de cet espace porte déjà ce nom.');
    await zone.getByRole('button', { name: 'Annuler' }).click();
    await addProject(page, 'Perso', 'Mission client');
    expect(await activeProjectNames(page, 'Perso')).toEqual(['Mission client']);
    expect(await activeProjectNames(page, 'Pro')).toEqual(['Mission client']);
  });

  test('ordre : « Descendre » ou ↓ sur la poignée, puis Alt+↑, changent l’ordre (critère 8)', async ({ page }, testInfo) => {
    await start(page);
    for (const name of ['Alpha', 'Bravo', 'Charlie']) await addProject(page, 'Pro', name);
    // Poignée : ↓ au clavier (iPhone : les flèches ne sont pas affichées) ; sur PC, le bouton « Descendre » fait de même.
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Déplacer le projet Alpha' }).focus();
      await page.keyboard.press('ArrowDown');
    } else {
      await page.getByRole('button', { name: 'Descendre le projet Alpha' }).click();
    }
    await expect.poll(() => activeProjectNames(page, 'Pro')).toEqual(['Bravo', 'Alpha', 'Charlie']);
    if (!isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Déplacer le projet Charlie' }).focus();
      await page.keyboard.press('Alt+ArrowUp');
      await expect.poll(() => activeProjectNames(page, 'Pro')).toEqual(['Bravo', 'Charlie', 'Alpha']);
    }
    // La liste « Projet » de la fiche suit l'ordre des Réglages.
    await backToToday(page);
    await createTask(page, testInfo, { title: 'Tâche test' });
    await rowOf(page, 'Tâche test').getByRole('button', { name: 'Tâche test', exact: true }).click();
    if (isPhone(testInfo)) {
      await detailOf(page).getByRole('button', { name: 'Modifier' }).click();
      const options = await page.getByRole('dialog', { name: 'Modifier la tâche' }).getByRole('combobox', { name: 'Projet' }).locator('option').allTextContents();
      expect(options).toEqual(['Aucun', 'Bravo', 'Alpha', 'Charlie']);
    } else {
      const options = await detailOf(page).getByRole('combobox', { name: 'Projet' }).locator('option').allTextContents();
      expect(options).toEqual(['Aucun', 'Bravo', 'Charlie', 'Alpha']);
    }
  });

  test('archivé : plus proposé, désarchivable ; la tâche garde son projet (critère 5)', async ({ page }, testInfo) => {
    await start(page);
    await addProject(page, 'Pro', 'Mission client');
    await addProject(page, 'Pro', 'Refonte site');
    await backToToday(page);
    await createTask(page, testInfo, { title: 'Envoyer la facture' });
    await setTaskProject(page, testInfo, 'Envoyer la facture', 'Mission client');
    await openSpacesScreen(page);
    await page.getByRole('button', { name: 'Archiver le projet Mission client' }).click();
    await expect(projectsOf(page, 'Pro').getByRole('group', { name: 'Archivés' }).getByText('Mission client')).toBeVisible();
    expect(await activeProjectNames(page, 'Pro')).toEqual(['Refonte site']);
    await backToToday(page);
    await rowOf(page, 'Envoyer la facture').getByRole('button', { name: 'Envoyer la facture', exact: true }).click();
    // La tâche affiche toujours son projet, archivé ; il n'est pas proposé aux autres.
    await expect(detailOf(page).getByText('Mission client (archivé)').first()).toBeVisible();
    if (!isPhone(testInfo)) {
      const options = await detailOf(page).getByRole('combobox', { name: 'Projet' }).locator('option').allTextContents();
      expect(options).toEqual(['Aucun', 'Refonte site', 'Mission client (archivé)']);
    }
    await detailOf(page).getByRole('button', { name: 'Fermer' }).click();
    await openSpacesScreen(page);
    await page.getByRole('button', { name: 'Désarchiver le projet Mission client' }).click();
    // Désarchivé, le projet retrouve sa place d'origine (son ordre n'a pas changé).
    expect(await activeProjectNames(page, 'Pro')).toEqual(['Mission client', 'Refonte site']);
  });

  test('menu « Projet : tous » : masqué en « Tout », filtre les tâches, remis à « tous » en changeant d’espace (critère 6, QB-15)', async ({ page }, testInfo) => {
    await start(page);
    await addProject(page, 'Pro', 'Mission client');
    await backToToday(page);
    await filterPill(page, 'Pro').click();
    await createTask(page, testInfo, { title: 'Envoyer la facture' });
    await createTask(page, testInfo, { title: 'Faire le point' });
    await setTaskProject(page, testInfo, 'Envoyer la facture', 'Mission client');

    // Visible sous Pro, à droite des pastilles ; masqué sous « Tout » et sous Perso (aucun projet).
    const menu = projectFilterMenu(page);
    await expect(menu).toBeVisible();
    await expect(page.getByText('Projet : tous')).toBeVisible();
    const pillsBox = await filterPill(page, 'Tout').boundingBox();
    const menuBox = await menu.locator('xpath=..').boundingBox();
    expect(menuBox?.x ?? 0).toBeGreaterThan((pillsBox?.x ?? 0) + (pillsBox?.width ?? 0) - 1);
    await filterPill(page, 'Tout').click();
    await expect(menu).toHaveCount(0);
    await filterPill(page, 'Perso').click();
    await expect(menu).toHaveCount(0);
    await filterPill(page, 'Pro').click();

    await menu.selectOption({ label: 'Mission client' });
    await expect(page.getByText('Projet : Mission client')).toBeVisible();
    await expect(rowOf(page, 'Envoyer la facture')).toBeVisible();
    await expect(rowOf(page, 'Faire le point')).toHaveCount(0);
    // La Semaine applique le même filtre.
    await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Envoyer la facture', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Faire le point', exact: true })).toHaveCount(0);
    await backToToday(page);
    await menu.selectOption({ label: 'Tous les projets' });
    await expect(rowOf(page, 'Faire le point')).toBeVisible();

    // Changer d'espace remet « Projet : tous ».
    await menu.selectOption({ label: 'Mission client' });
    await filterPill(page, 'Perso').click();
    await filterPill(page, 'Pro').click();
    await expect(page.getByText('Projet : tous')).toBeVisible();
    await expect(rowOf(page, 'Faire le point')).toBeVisible();
  });
});
