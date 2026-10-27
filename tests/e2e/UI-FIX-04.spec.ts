import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { openGoalScreen } from './helpers/goals';
import { openSomeday } from './helpers/someday';
import { isPhone } from './helpers/today';

/**
 * UI-FIX-04 — défaut 12 : le retour iPhone est à gauche partout (Objectif et Un jour vérifiés ici ; les autres écrans par le contrat
 * statique `backButtonsLeft.test.ts`). Même oracle que UI-FIX-03 : bord gauche du bouton aligné sur celui de sa rangée, centre dans la
 * moitié gauche. Projet `iphone` seulement.
 */
async function expectBackLeft(page: Page, row: Locator): Promise<void> {
  const back = page.getByRole('button', { name: 'Retour', exact: true });
  const rect = await back.boundingBox();
  const header = await row.boundingBox();
  if (rect === null || header === null) throw new Error('Retour ou rangée absent');
  expect(rect.x).toBeCloseTo(header.x, 0);
  expect(rect.x + rect.width / 2).toBeLessThan(220);
}

test.describe('UI-FIX-04 — retour iPhone à gauche', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'retour iPhone seulement');
    await openApp(page);
  });

  test('Objectif de la semaine', async ({ page }) => {
    await openGoalScreen(page);
    await expectBackLeft(page, page.locator('.ct-goals__topRow'));
  });

  test('Un jour', async ({ page }, testInfo) => {
    await openSomeday(page, testInfo);
    await expectBackLeft(page, page.locator('.ct-someday__topRow'));
  });
});
