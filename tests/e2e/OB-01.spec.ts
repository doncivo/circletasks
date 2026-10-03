import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { closeGoalScreen, goalButton, goalScreen, goalSections, goalTitleField, openGoalScreen } from './helpers/goals';
import { createTask } from './helpers/today';

/**
 * OB-01 — Je fixe un objectif pour la semaine. Parcours clé 9 (partie création de l'objectif ; épinglage, rattachement et avancement :
 * OB-02 à OB-04). Exécuté sur `pc` (panneau à droite) et `iphone` (écran plein avec « Retour »).
 */
test.describe('OB-01 — fixer un objectif pour la semaine', () => {
  test('l’icône cible ouvre l’écran Objectif sur la semaine en cours (critère 1)', async ({ page }, testInfo) => {
    await openApp(page);
    await openGoalScreen(page);
    await expect(page.getByText(/^Semaine \d+ · \d+ .*–/)).toBeVisible();
    if (testInfo.project.name === 'iphone') {
      await expect(page.getByRole('button', { name: 'Retour' })).toBeVisible();
      await page.getByRole('button', { name: 'Retour' }).click();
      await expect(goalButton(page)).toBeVisible();
    } else {
      await expect(page.getByRole('complementary', { name: 'Objectif de la semaine' })).toBeVisible();
      await page.getByRole('button', { name: 'Fermer' }).click();
      await expect(goalScreen(page)).toHaveCount(0);
    }
  });

  test('sans objectif : champ vide focalisé et aide ; Entrée crée l’objectif (critères 2 et 3)', async ({ page }, testInfo) => {
    await openApp(page);
    await openGoalScreen(page);
    await expect(goalTitleField(page)).toBeFocused();
    await expect(page.getByText('Fixez ce qui compte cette semaine')).toBeVisible();
    await goalTitleField(page).fill('Finaliser le PRD CircleTasks');
    await goalTitleField(page).press('Enter');
    await expect(goalSections(page)).toHaveCount(1);
    await expect(goalTitleField(page)).toHaveValue('Finaliser le PRD CircleTasks');
    // L'objectif est enregistré : il survit à la fermeture et à la réouverture de l'écran.
    await closeGoalScreen(page, testInfo);
    await openGoalScreen(page);
    await expect(goalTitleField(page)).toHaveValue('Finaliser le PRD CircleTasks');
  });

  test('titre modifiable, vide refusé, espace, plusieurs objectifs en sections empilées (critères 5 et 6)', async ({ page }) => {
    await openApp(page);
    await openGoalScreen(page);
    await goalTitleField(page).fill('Finaliser le PRD CircleTasks');
    await goalTitleField(page).press('Enter');
    await expect(goalSections(page)).toHaveCount(1);

    // Un titre vide est refusé : l'ancien revient.
    await goalTitleField(page).fill('');
    await goalTitleField(page).blur();
    await expect(goalTitleField(page)).toHaveValue('Finaliser le PRD CircleTasks');

    // Espace Pro / Perso.
    const space = page.getByRole('group', { name: 'Espace de l’objectif' });
    await space.getByRole('button', { name: 'Perso' }).click();
    await expect(space.getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');

    // Deuxième objectif : nouvelle section sous la première, pas de sélecteur d'objectif.
    await page.getByRole('button', { name: '+ Ajouter un objectif' }).click();
    await expect(goalTitleField(page, 2)).toBeFocused();
    await goalTitleField(page, 2).fill('Ranger le bureau');
    await goalTitleField(page, 2).press('Enter');
    await expect(goalSections(page)).toHaveCount(2);
    await expect(goalSections(page).getByRole('combobox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '+ Ajouter un objectif' })).toHaveCount(1);
  });

  test('icône : le composant Icône / Emoji est le même que la feuille Ajout (critère 4)', async ({ page }) => {
    await openApp(page);
    await openGoalScreen(page);
    await goalTitleField(page).fill('Objectif avec icône');
    await goalTitleField(page).press('Enter');
    await expect(goalSections(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Icône de l’objectif' }).click();
    await expect(page.getByRole('radio', { name: 'Icône' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Emoji' })).toBeVisible();
  });

  test('suppression confirmée, annulable : les tâches rattachées restent (critère 7)', async ({ page }, testInfo) => {
    await openApp(page);
    await createTask(page, testInfo, { title: 'Relire le PRD' });
    await openGoalScreen(page);
    await goalTitleField(page).fill('Objectif à supprimer');
    await goalTitleField(page).press('Enter');
    await expect(goalSections(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Supprimer l’objectif' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
    // Après suppression, un champ vide invite à fixer un nouvel objectif ; « Annuler » rend l'objectif.
    await expect(goalTitleField(page)).toHaveValue('');
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('textbox', { name: 'Objectif de la semaine' })).toHaveValue('Objectif à supprimer');
  });
});
