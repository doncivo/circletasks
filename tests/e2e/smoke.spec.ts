import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';

test('la coquille démarre avec la base de développement et affiche l’écran Aujourd’hui', async ({ page }, testInfo) => {
  await openApp(page);

  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-db-status', 'ready');
  const expectedLayout = testInfo.project.name === 'pc' ? 'pc' : 'mobile';
  await expect(shell).toHaveAttribute('data-layout', expectedLayout);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');

  await expect(page.getByRole('navigation')).toBeVisible();
  // UI-REFONTE-02 : sur iPhone, plus de badge « Aujourd’hui » ; le jour en grand (h1) tient lieu d'en-tête.
  if (expectedLayout === 'mobile') await expect(page.locator('main h1.ct-today__day')).toBeVisible();
  else await expect(page.getByText('Aujourd’hui', { exact: true })).toBeVisible();
});
