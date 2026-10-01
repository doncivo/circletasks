import { expect, test } from '@playwright/test';

test('la coquille démarre avec la base de développement et affiche l’écran Aujourd’hui', async ({ page }, testInfo) => {
  await page.goto('/');

  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-db-status', 'ready');
  const expectedLayout = testInfo.project.name === 'pc' ? 'pc' : 'mobile';
  await expect(shell).toHaveAttribute('data-layout', expectedLayout);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  await expect(page.getByRole('navigation')).toBeVisible();
  await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
});
