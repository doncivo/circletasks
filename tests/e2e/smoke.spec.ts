import { expect, test } from '@playwright/test';

test('la coquille démarre avec la base de développement', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'CircleTasks' })).toBeVisible();

  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-db-status', 'ready');
  const expectedLayout = testInfo.project.name === 'pc' ? 'pc' : 'mobile';
  await expect(shell).toHaveAttribute('data-layout', expectedLayout);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
});
