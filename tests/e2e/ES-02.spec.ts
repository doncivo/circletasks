import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { openRoutines, routineForm } from './helpers/routines';
import { createTask, isPhone, rowOf, todayTab } from './helpers/today';

/**
 * ES-02 — Chaque élément appartient à un espace.
 *
 * Couverture : espace proposé = filtre actif (Tout : Pro) pour une tâche et une routine ; choisir l'autre espace dans le
 * formulaire crée l'élément dans cet espace sans changer le filtre ; message « Ajouté dans Perso » quand l'élément est hors filtre.
 * La contrainte NOT NULL + clé étrangère de la base est vérifiée en Vitest (src/db/spaceOwnership.test.ts). Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-02 — espace des nouveaux éléments', () => {
  const filter = (page: Page) => page.getByRole('group', { name: 'Filtre d’espace' });
  const addRoutine = (page: Page, testInfo: { project: { name: string } }) =>
    page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();

  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('routine : Perso présélectionné sous le filtre Perso, Pro sous Tout (critère 2)', async ({ page }, testInfo) => {
    await openRoutines(page);
    await filter(page).getByRole('button', { name: 'Perso', exact: true }).click();
    await addRoutine(page, testInfo);
    await expect(routineForm(page, 'Nouvelle routine').getByRole('button', { name: 'Perso', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await routineForm(page, 'Nouvelle routine').getByRole('button', { name: 'Fermer' }).click();
    await filter(page).getByRole('button', { name: 'Tout', exact: true }).click();
    await addRoutine(page, testInfo);
    await expect(routineForm(page, 'Nouvelle routine').getByRole('button', { name: 'Pro', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('routine créée dans l’autre espace : le filtre reste, message « Ajouté dans Perso » (critères 3, 4)', async ({ page }, testInfo) => {
    await openRoutines(page);
    await filter(page).getByRole('button', { name: 'Pro', exact: true }).click();
    await addRoutine(page, testInfo);
    const form = routineForm(page, 'Nouvelle routine');
    await form.getByRole('button', { name: 'Perso', exact: true }).click();
    await form.getByLabel('Nom de la routine').fill('Lire 20 minutes');
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Ajouté dans Perso' })).toBeVisible();
    await expect(filter(page).getByRole('button', { name: 'Pro', exact: true })).toHaveAttribute('aria-pressed', 'true');
    // Hors du filtre Pro : la carte n'est pas listée ; elle l'est sous Perso.
    await expect(page.getByRole('heading', { level: 2, name: 'Lire 20 minutes' })).toHaveCount(0);
    await filter(page).getByRole('button', { name: 'Perso', exact: true }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Lire 20 minutes' })).toBeVisible();
  });

  test('tâche : créée dans l’espace du filtre, son espace est écrit sous Tout (critères 2, 5 de ES-03)', async ({ page }, testInfo) => {
    await filter(page).getByRole('button', { name: 'Perso', exact: true }).click();
    await createTask(page, testInfo, { title: 'Appeler maman' });
    await expect(page.getByText(/Ajouté dans/)).toHaveCount(0);
    await expect(rowOf(page, 'Appeler maman')).toBeVisible();
    await filter(page).getByRole('button', { name: 'Pro', exact: true }).click();
    await expect(rowOf(page, 'Appeler maman')).toHaveCount(0);
    await filter(page).getByRole('button', { name: 'Tout', exact: true }).click();
    await expect(rowOf(page, 'Appeler maman')).toContainText('Perso');
    await todayTab(page).click();
  });

  test('iPhone : la feuille « Nouvelle tâche » crée dans l’autre espace sans changer le filtre (critères 3, 4)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'feuille d’ajout : iPhone seulement (le PC saisit en ligne dans l’espace du filtre)');
    await filter(page).getByRole('button', { name: 'Pro', exact: true }).click();
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await expect(dialog.getByRole('button', { name: 'Pro', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByRole('button', { name: 'Perso', exact: true }).click();
    await dialog.getByLabel('Titre').fill('Courses du soir');
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Ajouté dans Perso' })).toBeVisible();
    await expect(filter(page).getByRole('button', { name: 'Pro', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, 'Courses du soir')).toHaveCount(0);
  });
});
