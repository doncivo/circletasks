import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * T-07 : Je consulte les tâches terminées.
 *
 * Horloge Playwright : le 23 sept. 2026 à 12:00 (Europe/Paris). Accès par l'icône graphique
 * d'Aujourd'hui (« Rapport mensuel ») puis le lien « Tâches terminées » (Q5). Couverture :
 * accès et période « Jour » par défaut (critère 1), rien de plus dans Aujourd'hui (1),
 * Semaine / Mois et en-têtes (2, 3), précédent / suivant et état vide (3, 8), groupes, heure
 * de fin et espace (4), filtre d'espace (5), rouvrir et annuler (6), fiche détail (7).
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

async function completeTask(page: Page, title: string): Promise<void> {
  await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
  await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeVisible();
}

async function openDoneScreen(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Rapport mensuel' }).click();
  await expect(page.getByRole('heading', { name: 'Rapport mensuel' })).toBeVisible();
  await page.getByRole('button', { name: 'Tâches terminées' }).click();
  await expect(page.getByRole('heading', { name: 'Tâches terminées', level: 1 })).toBeVisible();
}

test.describe('T-07 : tâches terminées', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-23T12:00:00+02:00') });
    await openApp(page);
    await expect(page.getByRole('navigation')).toBeVisible();
  });

  test('accès depuis le rapport, jour par défaut, heure de fin et espace (critères 1, 4)', async ({ page }, testInfo) => {
    const title = `Appeler Paul ${testInfo.project.name}`;
    // Rien n'est ajouté à la liste d'Aujourd'hui (critère 1) : le lien n'existe que dans le rapport.
    await expect(page.getByText('Tâches terminées')).toHaveCount(0);
    await createTask(page, testInfo, title);
    await completeTask(page, title);

    await openDoneScreen(page);
    await expect(page.getByRole('group', { name: 'Période' }).getByRole('button', { name: 'Jour', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('23 sept.', { exact: true })).toBeVisible();
    const row = page.locator('.ct-list-row', { has: page.getByRole('button', { name: title }) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(/terminée à \d\d:\d\d/);
    await expect(row).toContainText(/Pro|Perso/);
  });

  test('Semaine, Mois, précédent / suivant et état vide (critères 2, 3, 8)', async ({ page }, testInfo) => {
    const title = `Rapport ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await completeTask(page, title);
    await openDoneScreen(page);

    await page.getByRole('group', { name: 'Période' }).getByRole('button', { name: 'Semaine' }).click();
    await expect(page.getByText('21 – 27 sept.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: title })).toBeVisible();

    await page.getByRole('group', { name: 'Période' }).getByRole('button', { name: 'Mois' }).click();
    await expect(page.getByText('septembre 2026', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: title })).toBeVisible();

    await page.getByRole('button', { name: 'Période suivante' }).click();
    await expect(page.getByText('octobre 2026', { exact: true })).toBeVisible();
    await expect(page.getByText('Aucune tâche terminée sur cette période', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);

    await page.getByRole('button', { name: 'Période précédente' }).click();
    await expect(page.getByRole('button', { name: title })).toBeVisible();

    await page.getByRole('group', { name: 'Période' }).getByRole('button', { name: 'Jour', exact: true }).click();
    await page.getByRole('button', { name: 'Période précédente' }).click();
    await expect(page.getByText('Aucune tâche terminée sur cette période', { exact: true })).toBeVisible();
  });

  test('un jour passé : la tâche terminée hier se retrouve avec « précédent » (critères 3, 4)', async ({ page }, testInfo) => {
    const title = `Passée ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await completeTask(page, title);
    await page.clock.fastForward(13 * 3_600_000); // passé minuit : le 24 sept. à 01:00
    await openDoneScreen(page);
    await expect(page.getByText('24 sept.', { exact: true })).toBeVisible();
    await expect(page.getByText('Aucune tâche terminée sur cette période', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Période précédente' }).click();
    await expect(page.getByText('23 sept.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('filtre d’espace Pro / Perso / Tout (critère 5)', async ({ page }, testInfo) => {
    const title = `Dossier ${testInfo.project.name}`;
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    await createTask(page, testInfo, title);
    await completeTask(page, title);
    await openDoneScreen(page);

    await expect(page.getByRole('button', { name: title })).toBeVisible();
    await page.getByRole('button', { name: 'Pro', exact: true }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await expect(page.getByText('Aucune tâche terminée sur cette période', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tout', exact: true }).click();
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('décocher rouvre la tâche, « Annuler » la remet dans la liste (critère 6)', async ({ page }, testInfo) => {
    const title = `Facture ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await completeTask(page, title);
    await openDoneScreen(page);

    await page.getByRole('checkbox', { name: `Rouvrir : ${title}` }).click();
    await expect(page.getByRole('button', { name: title })).toHaveCount(0);
    await expect(page.getByText('Aucune tâche terminée sur cette période', { exact: true })).toBeVisible();
    await expect(page.getByText(`« ${title} » rouverte`)).toBeVisible();

    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('button', { name: title })).toBeVisible();
  });

  test('toucher une tâche ouvre sa fiche détail (critère 7)', async ({ page }, testInfo) => {
    const title = `Détail ${testInfo.project.name}`;
    await createTask(page, testInfo, title);
    await completeTask(page, title);
    await openDoneScreen(page);
    await page.getByRole('button', { name: title }).click();
    await expect(page.getByLabel('Détail de la tâche')).toBeVisible();
  });
});
