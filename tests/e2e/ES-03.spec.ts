import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertRoutines, openRoutines, cardOf } from './helpers/routines';
import { browserToday } from './helpers/schedule';
import { isPhone, rowOf, todayTab } from './helpers/today';
import { insertTasks, openWeek, taskButton, weekTab } from './helpers/week';

/**
 * ES-03 — Je filtre Pro / Perso / Tout. Parcours clé 6 (partie Aujourd'hui et Semaine ; les Statistiques arrivent à l'ordre 3).
 *
 * Couverture : « Pro » ne garde que les éléments Pro (aria-pressed) ; le filtre est unique (Aujourd'hui, Semaine, Routines) ;
 * en « Tout » l'espace est écrit en couleur sur la ligne, pas sous Pro / Perso ; écran vide « Aucune tâche Pro aujourd'hui » ;
 * Ctrl+1 / Ctrl+2 / Ctrl+3 sur PC. La mémorisation au redémarrage est vérifiée en Vitest (base du navigateur de développement en mémoire).
 * Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-03 — filtre Pro / Perso / Tout', () => {
  const filter = (page: Page) => page.getByRole('group', { name: 'Filtre d’espace' });
  const pill = (page: Page, name: string) => filter(page).getByRole('button', { name, exact: true });

  async function seed(page: Page): Promise<void> {
    await openApp(page);
    const today = await browserToday(page);
    await insertTasks(page, [
      { title: 'Facture client', date: today, space: 'pro', time: '09:00' },
      { title: 'Appeler maman', date: today, space: 'perso' },
    ]);
    await insertRoutines(page, [
      { title: 'Revue des e-mails', space: 'pro' },
      { title: 'Faire mon lit', space: 'perso' },
    ]);
    // Aujourd'hui relit ses éléments à l'ouverture : on repasse par la Semaine.
    await weekTab(page).click();
    await todayTab(page).click();
    await expect(rowOf(page, 'Facture client')).toBeVisible();
  }

  test('« Pro » ne garde que les éléments Pro ; « Tout » les rend (critère 1)', async ({ page }) => {
    await seed(page);
    await expect(pill(page, 'Tout')).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, 'Appeler maman')).toBeVisible();
    await pill(page, 'Pro').click();
    await expect(pill(page, 'Pro')).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, 'Appeler maman')).toHaveCount(0);
    await expect(rowOf(page, 'Facture client')).toBeVisible();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Revue des e-mails' })).toBeVisible();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Faire mon lit' })).toHaveCount(0);
    await pill(page, 'Tout').click();
    await expect(rowOf(page, 'Appeler maman')).toBeVisible();
  });

  test('le filtre est unique : Aujourd’hui, Semaine et Routines suivent (critère 2)', async ({ page }) => {
    await seed(page);
    await pill(page, 'Perso').click();
    await openWeek(page);
    await expect(pill(page, 'Perso')).toHaveAttribute('aria-pressed', 'true');
    await expect(taskButton(page, 'Appeler maman')).toBeVisible();
    await expect(taskButton(page, 'Facture client')).toHaveCount(0);
    await openRoutines(page);
    await expect(pill(page, 'Perso')).toHaveAttribute('aria-pressed', 'true');
    await expect(cardOf(page, 'Faire mon lit')).toBeVisible();
    await expect(cardOf(page, 'Revue des e-mails')).toHaveCount(0);
    await todayTab(page).click();
    await expect(pill(page, 'Perso')).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, 'Facture client')).toHaveCount(0);
  });

  test('« Tout » écrit l’espace en couleur, Pro et Perso non (critère 5)', async ({ page }) => {
    await seed(page);
    const row = rowOf(page, 'Facture client');
    await expect(row).toContainText('09:00 · Pro');
    await expect(row.getByText('Pro', { exact: true })).toHaveCSS('color', /^color\(srgb 0\.18\d* 0\.41\d* 0\.47\d*\)$/);
    const routine = page.locator('.ct-list-row').filter({ hasText: 'Faire mon lit' });
    await expect(routine).toContainText('Routine · Perso');
    await pill(page, 'Pro').click();
    await expect(rowOf(page, 'Facture client')).not.toContainText('Pro');
  });

  test('un filtre sans tâche l’indique (critère 6)', async ({ page }) => {
    await openApp(page);
    await pill(page, 'Pro').click();
    await expect(page.getByRole('heading', { name: 'Aucune tâche Pro aujourd’hui' })).toBeVisible();
    await pill(page, 'Perso').click();
    await expect(page.getByRole('heading', { name: 'Aucune tâche Perso aujourd’hui' })).toBeVisible();
    await pill(page, 'Tout').click();
    await expect(page.getByText('Rien de prévu aujourd’hui.', { exact: true })).toBeVisible();
  });

  test('PC : Ctrl+1 / Ctrl+2 / Ctrl+3 changent le filtre, liste focalisée comprise (critère 4)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'raccourcis clavier : PC seulement');
    await seed(page);
    await rowOf(page, 'Facture client').getByRole('button', { name: 'Facture client', exact: true }).focus();
    await page.keyboard.press('Control+1');
    await expect(pill(page, 'Pro')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+2');
    await expect(pill(page, 'Perso')).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, 'Facture client')).toHaveCount(0);
    await page.keyboard.press('Control+3');
    await expect(pill(page, 'Tout')).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, 'Facture client')).toBeVisible();
  });
});
