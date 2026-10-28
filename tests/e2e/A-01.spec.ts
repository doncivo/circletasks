import { expect, test } from '@playwright/test';
import { createTask, isPhone, openToday, rowOf, todayTab } from './helpers/today';

/**
 * A-01 — J'ouvre l'app sur la liste du jour.
 *
 * Couverture : démarrage sur l'onglet « Tâches » avec la date du jour et le badge (critères 1, 2), état vide
 * (7), « HH:MM · Espace » (5), filtre d'espace (6), flèches de jour sur PC seulement et retour par l'onglet
 * (10, Q10). Exécuté sur `pc` et `iphone`.
 *
 * Hors couverture e2e : routines, événements, checklists et objectif (modules M4, M6, M7, M17 pas encore
 * livrés : assemblage couvert par `src/domain/todayList.test.ts` et `TodayList.test.tsx`), minuit (critère 8,
 * `dayRollover.test.ts`) et 5 000 tâches (critère 9, `todayStore.perf.test.ts` : la base du navigateur de
 * développement est en mémoire).
 */
test.describe('A-01 — liste du jour', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('l’app démarre sur l’onglet Tâches avec le jour et le badge AUJOURD’HUI (critères 1, 2)', async ({ page }) => {
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
    // UI-REFONTE-02 : sur iPhone le badge a disparu, la ligne « maintenant » de l'agenda marque le jour courant.
    if (test.info().project.name === 'iphone') await expect(page.locator('.ct-agenda__now')).toBeVisible();
    else await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
    // Jour de Paris (fuseau du navigateur de test), jamais celui du processus de test (UTC en CI : un jour d'écart de 22:00 à minuit UTC).
    const today = new Date();
    const timeZone = 'Europe/Paris';
    const month = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone }).format(today);
    // PC : mois en toutes lettres ; iPhone : mois abrégé (« oct. 2026 »).
    const shortMonth = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric', timeZone }).format(today);
    await expect(page.getByText(test.info().project.name === 'iphone' ? shortMonth : month, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(new Intl.DateTimeFormat('fr-FR', { day: 'numeric', timeZone }).format(today));
  });

  test('l’état vide propose d’ajouter une tâche (critère 7)', async ({ page }) => {
    await expect(page.getByText('Rien de prévu aujourd’hui.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Ajoutez une tâche ci-dessous/)).toBeVisible();
  });

  test('une tâche affiche « HH:MM · Espace » en filtre Tout (critère 5)', async ({ page }, testInfo) => {
    const title = `Facture ${testInfo.project.name}`;
    await createTask(page, testInfo, { title, time: '09:00' });
    const row = rowOf(page, title);
    if (test.info().project.name === 'iphone') {
      // UI-REFONTE-02 : l'heure est dans la colonne de l'agenda ; la sous-ligne porte l'espace (précédé du retard si l'heure est passée).
      await expect(row.locator('xpath=ancestor::*[contains(@class, "ct-agenda__line")]').locator('.ct-agenda__hour')).toHaveText('09:00');
      await expect(row.locator('.ct-list-row__subtitle')).toHaveText(/Pro$/);
    } else {
      await expect(row).toContainText('09:00');
      await expect(row.locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('09:00 · Pro');
    }
    await expect(page.getByText('Rien de prévu aujourd’hui.', { exact: true })).toHaveCount(0);
  });

  test('le filtre d’espace limite la liste (critère 6)', async ({ page }, testInfo) => {
    const perso = `Perso ${testInfo.project.name}`;
    const pro = `Pro ${testInfo.project.name}`;
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    await createTask(page, testInfo, { title: perso });
    await page.getByRole('button', { name: 'Pro', exact: true }).click();
    await createTask(page, testInfo, { title: pro });
    await expect(page.getByRole('button', { name: pro, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: perso, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Tout', exact: true }).click();
    await expect(rowOf(page, perso).locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('Perso');
    await expect(rowOf(page, pro).locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('Pro');
  });

  test('flèches de jour : PC seulement, badge absent hors du jour courant, retour par l’onglet (critère 10, Q10)', async ({ page }, testInfo) => {
    if (isPhone(testInfo)) {
      await expect(page.getByRole('button', { name: 'Jour suivant' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Jour précédent' })).toHaveCount(0);
      return;
    }
    const heading = page.getByRole('heading', { level: 1 });
    const todayText = (await heading.textContent()) ?? '';
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    await expect(heading).not.toHaveText(todayText);
    await expect(page.getByText('Aujourd’hui', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Jour précédent' }).click();
    await page.getByRole('button', { name: 'Jour précédent' }).click();
    await expect(heading).not.toHaveText(todayText);
    await expect(page.getByText('Aujourd’hui', { exact: true })).toHaveCount(0);
    await todayTab(page).click();
    await expect(heading).toHaveText(todayText);
    await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
  });
});
