import { expect, test, type Page } from '@playwright/test';
import { createTask, openToday, rowOf } from './helpers/today';

/**
 * A-03 — Je masque les routines de la liste du jour.
 *
 * Couverture : interrupteur « Masquer les routines de la liste » en Réglages, désactivé par défaut (critère 1),
 * utilisable au clavier avec Espace et annoncé activé / désactivé (8), choix conservé au changement d'onglet
 * (6), tâches inchangées dans Aujourd'hui (2). Exécuté sur `pc` et `iphone`.
 *
 * Hors couverture e2e : disparition des routines elles-mêmes (3, 4, 5, 7) : le module Routines (M4) n'existe
 * pas encore ; la règle est testée par `src/domain/todayList.test.ts` et `TodayList.test.tsx` avec des
 * routines injectées, et la persistance entre redémarrages par `SettingsScreen.test.tsx` (la base du
 * navigateur de développement est en mémoire).
 */
test.describe('A-03 — masquer les routines', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  const nav = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

  test('désactivé par défaut, se bascule au clavier et reste choisi (critères 1, 6, 8)', async ({ page }) => {
    await nav(page, 'Réglages').click();
    await expect(page.getByRole('heading', { name: 'TÂCHES' })).toBeVisible();
    const toggle = page.getByRole('switch', { name: 'Masquer les routines de la liste' });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await nav(page, 'Tâches').click();
    await nav(page, 'Réglages').click();
    await expect(page.getByRole('switch', { name: 'Masquer les routines de la liste' })).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('switch', { name: 'Masquer les routines de la liste' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('switch', { name: 'Masquer les routines de la liste' })).toHaveAttribute('aria-checked', 'false');
  });

  test('les tâches restent affichées quand les routines sont masquées (critère 2)', async ({ page }, testInfo) => {
    const title = `Tâche ${testInfo.project.name}`;
    await createTask(page, testInfo, { title });
    await nav(page, 'Réglages').click();
    await page.getByRole('switch', { name: 'Masquer les routines de la liste' }).click();
    await expect(page.getByRole('switch', { name: 'Masquer les routines de la liste' })).toHaveAttribute('aria-checked', 'true');
    await nav(page, 'Tâches').click();
    await expect(rowOf(page, title)).toBeVisible();
    await expect(page.locator('.ct-list-row__subtitle', { hasText: 'Routine' })).toHaveCount(0);
  });
});
