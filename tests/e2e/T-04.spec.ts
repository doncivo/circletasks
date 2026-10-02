import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-04 — Je marque une tâche terminée.
 *
 * Couverture : cocher (case cochée, titre barré, libellé « Rouvrir ») et message
 * « Annuler » (critères 1, 3, 9) ; tâche terminée descendue sous les tâches à faire
 * (critère 2) ; Annuler dans les 5 s (critère 3) ; message expiré après 5 s, la
 * tâche reste terminée ; décocher = rouvrir (critère 5) ; bouton « Marquer comme
 * terminée » de la fiche (critère 1). Exécuté sur `pc` et `iphone`.
 *
 * Hors couverture e2e : Ctrl+Z (T-13), occurrence récurrente (T-09), changement de
 * minuit (T-07) ; Espace sur ligne sélectionnée couvert en Testing Library et
 * réservé au projet `pc`.
 */

async function createTask(page: Page, testInfo: { project: { name: string } }, title: string): Promise<void> {
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

test.describe('T-04 — terminer une tâche', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('cocher termine la tâche : case cochée, titre barré, message Annuler (critères 1, 3, 9)', async ({ page }, testInfo) => {
    const title = `Boire de l’eau ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();

    const box = page.getByRole('checkbox', { name: `Rouvrir : ${title}` });
    await expect(box).toHaveAttribute('aria-checked', 'true');
    const row = page.locator('.ct-list-row', { hasText: title });
    await expect(row).toHaveAttribute('data-done', 'true');
    await expect(row.locator('.ct-list-row__title')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.getByRole('status')).toContainText(`« ${title} » terminée`);
  });

  test('la tâche terminée descend sous les tâches à faire puis Annuler la remonte (critères 2, 3)', async ({ page }, testInfo) => {
    const stamp = `${testInfo.project.name}-${Date.now()}`;
    const first = `Première ${stamp}`;
    const second = `Seconde ${stamp}`;
    await createTask(page, testInfo, first);
    await createTask(page, testInfo, second);
    const titles = page.locator('.ct-list-row__title');
    await expect(titles).toHaveText([first, second]);

    await page.getByRole('checkbox', { name: `Terminer : ${first}` }).click();
    await expect(titles).toHaveText([second, first]);

    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(titles).toHaveText([first, second]);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${first}` })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('le message disparaît après 5 s, la tâche reste terminée (critère 3)', async ({ page }, testInfo) => {
    const title = `Expire ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await expect(page.getByRole('status')).toBeVisible();

    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toHaveAttribute('aria-checked', 'true');
  });

  test('décocher une tâche terminée la rouvre (critère 5)', async ({ page }, testInfo) => {
    const title = `Rouvrir ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();

    await page.getByRole('checkbox', { name: `Rouvrir : ${title}` }).click();

    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).toHaveAttribute('aria-checked', 'false');
  });

  test('Espace sur la ligne sélectionnée termine la tâche (critère 6)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'Raccourci clavier PC');
    const title = `Espace ${Date.now()}`;
    await createTask(page, testInfo, title);

    await page.getByRole('button', { name: title }).focus();
    await page.keyboard.press('Space');

    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeVisible();
  });

  test('« Marquer comme terminée » dans la fiche termine la tâche (critère 1)', async ({ page }, testInfo) => {
    const title = `Fiche ${testInfo.project.name} ${Date.now()}`;
    await createTask(page, testInfo, title);
    await page.getByRole('button', { name: title, exact: true }).click();
    const detail =
      testInfo.project.name === 'iphone'
        ? page.getByRole('dialog', { name: 'Détail de la tâche' })
        : page.getByRole('complementary', { name: 'Détail de la tâche' });

    if (testInfo.project.name === 'iphone') {
      await detail.getByRole('button', { name: 'Marquer comme terminée' }).click();
      await expect(detail.getByRole('button', { name: 'Marquer comme terminée' })).toHaveAttribute('aria-pressed', 'true');
    } else {
      // PC (PC-Aujourdhui.html) : le panneau n'a pas ce bouton, terminer reste sur la case de la ligne.
      await expect(detail.getByRole('button', { name: 'Marquer comme terminée' })).toHaveCount(0);
      await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    }
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeAttached();
  });
});
