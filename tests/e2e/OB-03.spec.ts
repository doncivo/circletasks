import { expect, test, type Locator } from '@playwright/test';
import { openApp } from './helpers/app';
import { browserWeek, closeGoalScreen, goalSections, insertGoals, openGoalScreen } from './helpers/goals';
import { detailOf } from './helpers/spaces';
import { createTask, isPhone, rowOf } from './helpers/today';

/**
 * OB-03 — Je rattache une tâche à un objectif. Parcours clé 9 (rattachement : un seul objectif = direct, plusieurs = liste, QB-13).
 * Exécuté sur `pc` (interrupteur de la fiche) et `iphone` (fiche en feuille et feuille « Nouvelle tâche »).
 */
test.describe('OB-03 — rattacher une tâche à un objectif', () => {
  const attachSwitch = (scope: Locator) => scope.getByRole('switch', { name: 'Rattacher à mon objectif' });

  test('aucun objectif cette semaine : interrupteur inactif avec l’aide (critère 2)', async ({ page }, testInfo) => {
    await openApp(page);
    await createTask(page, testInfo, { title: 'Relire le PRD' });
    await rowOf(page, 'Relire le PRD').getByRole('button', { name: 'Relire le PRD', exact: true }).click();
    const fiche = detailOf(page);
    await expect(fiche.getByText('Aucun objectif cette semaine')).toBeVisible();
    await expect(attachSwitch(fiche)).toBeDisabled();
  });

  test('un seul objectif ouvert : rattachement direct, icône cible sur la ligne, liste de l’écran Objectif, détachement (critères 1, 3, 4, 5, 7)', async ({ page }, testInfo) => {
    await openApp(page);
    await insertGoals(page, [{ title: 'Finaliser le PRD CircleTasks', weekStart: await browserWeek(page) }]);
    await createTask(page, testInfo, { title: 'Relire le PRD' });
    await rowOf(page, 'Relire le PRD').getByRole('button', { name: 'Relire le PRD', exact: true }).click();
    const fiche = detailOf(page);
    await expect(attachSwitch(fiche)).toBeEnabled();
    await attachSwitch(fiche).click();
    await expect(fiche.getByText('Rattachée : Finaliser le PRD CircleTasks')).toBeVisible();
    await expect(attachSwitch(fiche)).toHaveAttribute('aria-checked', 'true');

    // Ferme la fiche : la ligne porte l'icône cible.
    await page.keyboard.press('Escape');
    await expect(fiche).toHaveCount(0);
    await expect(rowOf(page, 'Relire le PRD').getByRole('img', { name: 'Rattachée à l’objectif' })).toBeVisible();

    // L'écran Objectif liste la tâche avec sa case et son jour ; la cocher la termine.
    await openGoalScreen(page);
    const section = goalSections(page).first();
    await expect(section.getByRole('checkbox', { name: 'Terminer : Relire le PRD' })).toBeVisible();
    await section.getByRole('checkbox', { name: 'Terminer : Relire le PRD' }).click();
    await expect(section.getByRole('checkbox', { name: 'Rouvrir : Relire le PRD' })).toBeVisible();
    await closeGoalScreen(page, testInfo);
    await expect(rowOf(page, 'Relire le PRD').getByRole('checkbox', { name: 'Rouvrir : Relire le PRD' })).toBeVisible();

    // Détachement par l'interrupteur.
    await rowOf(page, 'Relire le PRD').getByRole('button', { name: 'Relire le PRD', exact: true }).click();
    await attachSwitch(detailOf(page)).click();
    await expect(detailOf(page).getByText('Non rattachée')).toBeVisible();
  });

  test('plusieurs objectifs : liste à choisir, une tâche Perso sert un objectif Pro ; fermer sans choisir ne rattache rien (critère 7, QB-13)', async ({ page }, testInfo) => {
    await openApp(page);
    const monday = await browserWeek(page);
    await insertGoals(page, [
      { title: 'Objectif Pro', weekStart: monday, space: 'pro' },
      { title: 'Objectif Perso', weekStart: monday, space: 'perso' },
    ]);
    await createTask(page, testInfo, { title: 'Appeler maman' });
    await rowOf(page, 'Appeler maman').getByRole('button', { name: 'Appeler maman', exact: true }).click();
    const fiche = detailOf(page);
    await attachSwitch(fiche).click();
    const dialog = page.getByRole('alertdialog', { name: 'Rattacher à quel objectif ?' });
    await expect(dialog.getByRole('button', { name: 'Objectif Pro · Pro' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Objectif Perso · Perso' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(attachSwitch(fiche)).toHaveAttribute('aria-checked', 'false');

    await attachSwitch(fiche).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Objectif Pro · Pro' }).click();
    await expect(fiche.getByText('Rattachée : Objectif Pro')).toBeVisible();
  });

  test('feuille « Nouvelle tâche » : l’interrupteur rattache la tâche créée (critère 1, iPhone)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La feuille d’ajout est propre à l’iPhone ; sur PC, rattachement par la fiche');
    await openApp(page);
    await insertGoals(page, [{ title: 'Finaliser le PRD CircleTasks', weekStart: await browserWeek(page) }]);
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill('Écrire le plan');
    await attachSwitch(dialog).click();
    await expect(dialog.getByText('Rattachée : Finaliser le PRD CircleTasks')).toBeVisible();
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(rowOf(page, 'Écrire le plan').getByRole('img', { name: 'Rattachée à l’objectif' })).toBeVisible();
  });
});
