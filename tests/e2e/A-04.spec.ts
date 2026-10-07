import { expect, test, type Page } from '@playwright/test';
import { waitForScreenLoaded } from './helpers/app';
import { createTask, isPhone, openToday, todayTab } from './helpers/today';

/**
 * A-04 — J'accède à Aujourd'hui en un geste.
 *
 * Couverture : Alt+1 depuis un autre onglet, un autre jour et un sous-écran (critères 1, 4), dans un champ de
 * saisie sans y insérer de caractère (2), onglet « Tâches » visible et actif sur tous les écrans (3), Alt+2 à
 * Alt+6 (6), Alt+1 ignoré devant une feuille ouverte avec une saisie (5, `iphone`). Exécuté sur `pc` et
 * `iphone`. Clavier AZERTY : couvert en test unitaire (`tabShortcuts.test.ts`, touche « & »).
 */
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

test.describe('A-04 — Aujourd’hui en un geste', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
    // Le rapport est un écran à la demande : on attend son bloc plutôt que de courir contre le serveur (voir waitForScreenLoaded).
    await waitForScreenLoaded(page, 'reportscreen');
    await waitForScreenLoaded(page, 'settingsscreen');
  });

  test('Alt+1 ramène à Aujourd’hui depuis Réglages et l’onglet est actif (critère 1)', async ({ page }) => {
    await tab(page, 'Réglages').click();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
    await expect(tab(page, 'Réglages')).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Alt+1');
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
  });

  test('Alt+2 à Alt+6 activent les autres onglets (critère 6)', async ({ page }) => {
    const names = ['Semaine', 'Routines', 'Événements', 'Checklists', 'Réglages'];
    for (const [index, name] of names.entries()) {
      await page.keyboard.press(`Alt+${index + 2}`);
      await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
      // L'onglet « Tâches » reste visible sur tous les écrans à onglets (critère 3).
      await expect(todayTab(page)).toBeVisible();
    }
    await page.keyboard.press('Alt+1');
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
  });

  test('Alt+1 depuis un sous-écran de Tâches revient à Aujourd’hui (critère 4)', async ({ page }) => {
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    await expect(page.getByText('Rapport du mois', { exact: true })).toBeVisible();
    await page.keyboard.press('Alt+1');
    await expect(page.getByText('Rapport du mois', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    await todayTab(page).click();
    await expect(page.getByText('Rapport du mois', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
  });

  test('Alt+1 ramène du jour suivant au jour courant (PC, Q10, critère 4)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Les flèches de jour n’existent que sur PC.');
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(page.getByText('Aujourd’hui', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Alt+1');
    await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
  });

  test('Alt+1 ferme la fiche détail et fonctionne dans un champ de saisie sans y écrire (critères 1, 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Raccourci clavier PC ; la fiche iPhone est une feuille modale (critère 5).');
    const title = 'Tâche fiche';
    await createTask(page, testInfo, { title });
    await page.getByRole('button', { name: title, exact: true }).click();
    const detail = page.getByRole('complementary', { name: 'Détail de la tâche' });
    await expect(detail).toBeVisible();
    await tab(page, 'Semaine').click();
    await expect(tab(page, 'Semaine')).toHaveAttribute('aria-current', 'page');

    const field = page.getByLabel('Nouvelle tâche');
    await todayTab(page).click();
    await field.focus();
    await field.fill('abc');
    await page.keyboard.press('Alt+1');
    await expect(field).toHaveValue('abc');
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(detail).toHaveCount(0);
  });

  test('une feuille ouverte avec une saisie reste ouverte : Alt+2 est ignoré (critère 5)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La feuille « Nouvelle tâche » n’existe que sur iPhone.');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill('Saisie en cours');
    await page.keyboard.press('Alt+2');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Titre')).toHaveValue('Saisie en cours');
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
  });
});

test.describe('A-04 — bloc du rapport lent à arriver (serveur à froid, machine chargée)', () => {
  test('Alt+1 depuis le rapport reste correct quand son bloc arrive après 6 s (critère 4)', async ({ page }) => {
    // Non-régression de l'instabilité : le bloc de ReportScreen (écran à la demande) mettait plus de 5 s, délai d'une assertion.
    await page.route('**/src/features/stats/ReportScreen.tsx*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6000));
      await route.continue();
    });
    await openToday(page);
    await waitForScreenLoaded(page, 'reportscreen');
    await page.getByRole('button', { name: 'Rapport mensuel' }).click();
    await expect(page.getByText('Rapport du mois', { exact: true })).toBeVisible();
    await page.keyboard.press('Alt+1');
    await expect(page.getByText('Rapport du mois', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
  });
});
