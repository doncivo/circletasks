import { expect, test, type Page } from '@playwright/test';

/**
 * 0.2.2 : l'ouverture de la base ne laisse plus jamais « Chargement… » sans fin ni un écran d'échec sans issue.
 * Le premier chargement de la page simule l'ouverture (prise `__ctDbOpen` du développement) ; « Réessayer » recharge la page, dont
 * le second chargement ouvre la vraie base (le drapeau est gardé dans sessionStorage, qui survit au rechargement).
 */
/**
 * Budget de la vraie ouverture après « Réessayer » : c'est la première fois que la page charge SQLite Wasm (le premier chargement
 * simulé ne l'a pas importé), ce qui dépasse 5 s sur un exécuteur CI froid. Borne d'attente d'un chargement réel, pas un correctif.
 */
const READY_BUDGET_MS = 30_000;

async function simulateFirstOpen(page: Page, kind: 'never' | 'reject'): Promise<void> {
  await page.addInitScript((mode) => {
    if (sessionStorage.getItem('ct-test-open-simulated')) return;
    sessionStorage.setItem('ct-test-open-simulated', '1');
    const g = globalThis as { __ctDbOpen?: () => Promise<never>; __ctDbWatchdogMs?: number };
    g.__ctDbWatchdogMs = 600;
    g.__ctDbOpen = () => (mode === 'never' ? new Promise<never>(() => undefined) : Promise.reject(new Error('database is locked')));
  }, kind);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement;
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('0.2.2 — ouverture de la base en échec ou sans réponse', () => {
  test('sans réponse : le chien de garde affiche l’étape et « Réessayer » relance et réussit', async ({ page }) => {
    await simulateFirstOpen(page, 'never');
    await page.goto('/');
    const detail = page.getByTestId('db-failure-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Aucune réponse de la base de données');
    await expect(detail).toContainText('Étape : chargement du plugin SQL');
    await expectNoHorizontalScroll(page);

    const retry = page.getByRole('button', { name: 'Réessayer' });
    const box = await retry.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await Promise.all([page.waitForEvent('load'), retry.click()]);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-db-status', 'ready', { timeout: READY_BUDGET_MS });
    await expect(detail).toBeHidden();
  });

  test('ouverture rejetée : diagnostic visible, « Réessayer » relance et réussit', async ({ page }) => {
    await simulateFirstOpen(page, 'reject');
    await page.goto('/');
    const detail = page.getByTestId('db-failure-detail');
    await expect(detail).toContainText('database is locked');
    await expectNoHorizontalScroll(page);

    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Réessayer' }).click()]);
    await expect(page.locator('.app-shell')).toHaveAttribute('data-db-status', 'ready', { timeout: READY_BUDGET_MS });
    await expect(detail).toBeHidden();
  });
});
