import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';

/**
 * ES-01 — J'ai deux espaces Pro et Perso.
 *
 * Couverture : Réglages › Espaces et projets (deux espaces, nom, palette de quatre couleurs, aucune création ni suppression),
 * renommage visible aussitôt dans les pastilles d'Aujourd'hui, refus d'un nom vide ou identique à l'autre espace, changement de
 * couleur. La persistance après redémarrage est vérifiée en Vitest (la base du navigateur de développement est en mémoire).
 * Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-01 — espaces Pro et Perso', () => {
  async function openSpaces(page: Page): Promise<void> {
    await openApp(page);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByText('ESPACES ET CALENDRIERS', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Espaces et projets :/ }).click();
    await expect(page.getByRole('heading', { name: 'Espaces et projets' })).toBeVisible();
  }

  test('deux espaces, palette de quatre couleurs, ni création ni suppression (critères 1, 2, 5, 6)', async ({ page }) => {
    await openApp(page);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Espaces et projets : Pro (0) · Perso (0)' })).toBeVisible();
    await page.getByRole('button', { name: /^Espaces et projets :/ }).click();
    await expect(page.getByLabel('Nom de l’espace 1')).toHaveValue('Pro');
    await expect(page.getByLabel('Nom de l’espace 2')).toHaveValue('Perso');
    await expect(page.getByRole('radiogroup', { name: 'Couleur de l’espace Pro' }).getByRole('radio')).toHaveCount(4);
    await expect(page.getByRole('radiogroup', { name: 'Couleur de l’espace Perso' }).getByRole('radio')).toHaveCount(4);
    await expect(page.getByRole('button', { name: /(supprimer|créer|ajouter).*espace/i })).toHaveCount(0);
  });

  test('renommer Pro en Conseil : le nom apparaît dans les pastilles d’Aujourd’hui (critère 3)', async ({ page }) => {
    await openSpaces(page);
    await page.getByLabel('Nom de l’espace 1').fill('Conseil');
    await page.getByLabel('Nom de l’espace 1').press('Enter');
    await expect(page.getByRole('radiogroup', { name: 'Couleur de l’espace Conseil' })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Conseil', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pro', exact: true })).toHaveCount(0);
  });

  test('un nom vide ou identique à l’autre espace est refusé, l’ancien nom reste (critère 4)', async ({ page }) => {
    await openSpaces(page);
    const field = page.getByLabel('Nom de l’espace 1');
    await field.fill('   ');
    await field.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Le nom ne peut pas être vide.');
    await expect(field).toHaveValue('Pro');
    await field.fill('perso');
    await field.press('Enter');
    await expect(page.getByRole('alert')).toHaveText('Ce nom est déjà utilisé par l’autre espace.');
    await expect(field).toHaveValue('Pro');
  });

  test('choisir une autre couleur de la palette (critère 5)', async ({ page }) => {
    await openSpaces(page);
    const violet = page.getByRole('radio', { name: 'Violet' });
    await violet.click();
    await expect(violet).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Bleu canard' })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    const pill = page.getByRole('button', { name: 'Pro', exact: true });
    await expect(pill).toHaveCSS('border-top-color', 'color(srgb 0.356863 0.262745 0.658824)');
  });
});
