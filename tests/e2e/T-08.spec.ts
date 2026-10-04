import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-08 : Je supprime une tâche.
 *
 * Horloge Playwright : le 23 sept. 2026 à 12:00 (Europe/Paris). Couverture : confirmation
 * avec focus sur « Annuler » (critère 1), suppression, fiche fermée et message « Annuler »
 * (2, 3), annulation de la confirmation et Échap (4), touche Suppr sur PC (1), corbeille
 * ouverte depuis Réglages > DONNÉES ET SÉCURITÉ (5), restauration (6), expiration à 30 jours (7).
 * Exécuté sur `pc` et `iphone`.
 */

type Info = { project: { name: string } };

async function createTask(page: Page, testInfo: Info, title: string): Promise<void> {
  if (testInfo.project.name === 'iphone') {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
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

/** Ouvre la fiche détail et renvoie le bouton de suppression (libellé propre à l'appareil). */
async function openDetail(page: Page, testInfo: Info, title: string) {
  await page.getByRole('button', { name: title }).click();
  const detail = page.getByLabel('Détail de la tâche');
  await expect(detail).toBeVisible();
  const label = testInfo.project.name === 'iphone' ? 'Supprimer la tâche' : 'Supprimer';
  return { detail, deleteButton: detail.getByRole('button', { name: label, exact: true }) };
}

async function openTrash(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DONNÉES ET SÉCURITÉ' })).toBeVisible();
  await page.getByRole('button', { name: 'Ouvrir la corbeille' }).click();
  await expect(page.getByRole('heading', { name: 'Corbeille', level: 1 })).toBeVisible();
}

test.describe('T-08 : supprimer une tâche', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-23T12:00:00+02:00') });
    await openApp(page);
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('confirmation, suppression, fiche fermée, message et « Annuler » (critères 1, 2, 3)', async ({ page }, testInfo) => {
    const title = `Courses ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    const { detail, deleteButton } = await openDetail(page, testInfo, title);

    await deleteButton.click();
    const confirmation = page.getByRole('alertdialog', { name: `Supprimer « ${title} » ?` });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByRole('button', { name: 'Annuler' })).toBeFocused();
    await expect(confirmation.getByRole('button', { name: 'Supprimer', exact: true })).toBeVisible();

    await confirmation.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(detail).not.toBeVisible();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText(new RegExp(`« ${title} » supprimée`));

    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('« Annuler » dans la confirmation et Échap ne suppriment rien (critère 4)', async ({ page }, testInfo) => {
    const title = `Garder ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    const { detail, deleteButton } = await openDetail(page, testInfo, title);

    await deleteButton.click();
    const confirmation = page.getByRole('alertdialog');
    await confirmation.getByRole('button', { name: 'Annuler' }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(detail).toBeVisible();

    await deleteButton.click();
    await expect(confirmation).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirmation).not.toBeVisible();
    await expect(detail).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);

    await page.keyboard.press('Escape'); // referme la fiche
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('touche Suppr sur la ligne sélectionnée, puis Ctrl+Z (PC, critères 1, 3)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'iphone', 'Touche Suppr : clavier PC uniquement');
    const title = `Suppr ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).focus();

    await page.keyboard.press('Delete');
    const confirmation = page.getByRole('alertdialog', { name: `Supprimer « ${title} » ?` });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);

    await page.keyboard.press('Control+z');
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('la corbeille, ouverte depuis Réglages, liste la tâche supprimée et la restaure (critères 5, 6)', async ({ page }, testInfo) => {
    const title = `Corbeille ${testInfo.project.name}`;
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    await createTask(page, testInfo, title);
    const { deleteButton } = await openDetail(page, testInfo, title);
    await deleteButton.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);

    await openTrash(page);
    const row = page.getByRole('listitem').filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/supprimée le .*23 sept\./);
    await expect(row).toContainText('Perso');

    await page.getByRole('button', { name: `Restaurer : ${title}` }).click();
    await expect(page.getByText('La corbeille est vide')).toBeVisible();

    await page.getByRole('button', { name: 'Retour' }).click();
    await page.getByRole('navigation').getByText('Tâches', { exact: true }).click();
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('une suppression de plus de 30 jours n’est plus dans la corbeille (critère 7)', async ({ page }, testInfo) => {
    const title = `Ancienne ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    const { deleteButton } = await openDetail(page, testInfo, title);
    await deleteButton.click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer', exact: true }).click();

    await openTrash(page);
    await expect(page.getByRole('listitem').filter({ hasText: title })).toBeVisible();
    await page.getByRole('button', { name: 'Retour' }).click();

    // Deux sauts de 16 jours : un seul saut de 31 jours dépasse les 2^31 ms acceptées par l'horloge.
    await page.clock.fastForward(16 * 24 * 3_600_000);
    await page.clock.fastForward(16 * 24 * 3_600_000);
    await openTrash(page);
    await expect(page.getByText('La corbeille est vide')).toBeVisible();
    await expect(page.getByText(title)).toHaveCount(0);
  });
});
