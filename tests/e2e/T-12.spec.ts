import { expect, test, type Page } from '@playwright/test';

/**
 * T-12 — Je duplique une tâche.
 *
 * Couverture : PC, Ctrl+Maj+D sur la ligne sélectionnée ouvre le sélecteur présélectionné sur
 * la date de l'original (critère 1) ; bouton « Dupliquer » de la fiche sur PC et iPhone
 * (critère 2, écart A-08) ; copie créée avec message « dupliquée » et « Annuler » (critères 3, 7) ;
 * « Annuler » supprime la copie ; Échap ne crée rien (critère 6) ; la fiche de la copie
 * n'est pas ouverte (critère 9). Rappels, « Un jour », tâche terminée : tests unitaires et
 * Testing Library. Exécuté sur `pc` et `iphone`.
 */

type Info = { project: { name: string } };

async function createTask(page: Page, testInfo: Info, title: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill(title);
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    return;
  }
  const field = page.getByLabel('Nouvelle tâche');
  await field.fill(title);
  await field.press('Enter');
  await expect(field).toHaveValue('');
}

test.describe('T-12 — dupliquer une tâche', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('la fiche propose « Dupliquer » : sélecteur présélectionné, copie créée, Annuler la supprime (critères 2, 3, 7, 9)', async ({ page }, testInfo) => {
    const title = `Courses ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title }).click();
    const detail = page.getByRole('dialog', { name: 'Détail de la tâche' }).or(page.getByRole('complementary', { name: 'Détail de la tâche' }));
    await detail.getByRole('button', { name: 'Dupliquer la tâche' }).click();

    const picker = page.getByRole('dialog', { name: 'Choisir la date de la copie' });
    await expect(picker).toBeVisible();
    // Présélection : la date de l'original (aujourd'hui) ; « Un jour » reste proposé (Q8).
    if (testInfo.project.name === 'iphone') await expect(picker.getByRole('spinbutton', { name: 'Jour' })).toHaveAttribute('aria-valuetext', 'Aujourd’hui');
    else await expect(picker.getByRole('textbox', { name: 'Date' })).toHaveValue('Aujourd’hui');
    await picker.getByRole('button', { name: 'Dupliquer' }).click();

    await expect(page.getByRole('status')).toContainText(`« ${title} » dupliquée`);
    await expect(page.getByRole('button', { name: title })).toHaveCount(2);
    // La fiche reste sur l'original ; la copie n'est pas ouverte.
    await expect(detail).toBeVisible();

    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(1);
  });

  test('« Un jour » dans le sélecteur : la copie quitte Aujourd’hui (critère 5)', async ({ page }, testInfo) => {
    const title = `Un jour ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title }).click();
    const detail = page.getByRole('dialog', { name: 'Détail de la tâche' }).or(page.getByRole('complementary', { name: 'Détail de la tâche' }));
    await detail.getByRole('button', { name: 'Dupliquer la tâche' }).click();
    const picker = page.getByRole('dialog', { name: 'Choisir la date de la copie' });
    await picker.getByRole('button', { name: 'Un jour' }).click();
    await picker.getByRole('button', { name: 'Dupliquer' }).click();
    await expect(page.getByRole('status')).toContainText('dupliquée');
    await expect(page.getByRole('button', { name: title })).toHaveCount(1);
  });

  test('fermer le sélecteur ne crée rien (critère 6)', async ({ page }, testInfo) => {
    const title = `Rien ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title }).click();
    const detail = page.getByRole('dialog', { name: 'Détail de la tâche' }).or(page.getByRole('complementary', { name: 'Détail de la tâche' }));
    await detail.getByRole('button', { name: 'Dupliquer la tâche' }).click();
    const picker = page.getByRole('dialog', { name: 'Choisir la date de la copie' });
    await picker.getByRole('button', { name: 'Fermer' }).click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.getByRole('button', { name: title })).toHaveCount(1);
  });

  test('PC : Ctrl+Maj+D sur la ligne sélectionnée ouvre le sélecteur (critère 1)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'Raccourci clavier PC');
    const title = 'Raccourci copie';
    await createTask(page, testInfo, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).focus();
    await page.keyboard.press('Control+Shift+D');
    const picker = page.getByRole('dialog', { name: 'Choisir la date de la copie' });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).not.toBeVisible();
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).focus();
    await page.keyboard.press('Control+Shift+D');
    await page.getByRole('dialog', { name: 'Choisir la date de la copie' }).getByRole('button', { name: 'Dupliquer' }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(2);
    await expect(page.getByRole('complementary', { name: 'Détail de la tâche' })).toHaveCount(0);
  });
});
