import { expect, test } from '@playwright/test';

/**
 * D-01 à D-03 — intégration PC, vue depuis le navigateur (npm run dev) et la mise en page iPhone.
 *
 * L'icône de zone de notification, le démarrage avec Windows et la mise à jour n'existent que
 * dans l'app Tauri Windows : ils sont couverts par cargo test, Vitest et la vérification
 * manuelle (docs/stories/D-0x.md). Ici : garantir que hors PC l'écran Réglages n'expose
 * aucune ligne PC (D-02 critère 1 : « cette ligne n'existe pas sur iPhone ») et que le
 * front démarre sans erreur sans intégration PC. Exécuté sur `pc` et `iphone`.
 */
test("Réglages hors app PC : ni « Démarrer avec Windows » ni « À propos » (D-02, D-03)", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Reporter les tâches non faites' })).toBeEnabled();

  await expect(page.getByRole('switch', { name: 'Démarrer avec Windows' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'À PROPOS' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'GÉNÉRAL' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Mise à jour de CircleTasks' })).toHaveCount(0);
  expect(errors).toEqual([]);
});
