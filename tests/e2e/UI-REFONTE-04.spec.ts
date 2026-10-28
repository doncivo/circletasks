import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { expectFitsViewport } from './helpers/layout';
import { openSyncDetails } from './helpers/sync';

/**
 * UI-REFONTE-04 — Réglages › Synchronisation (docs/maquettes-refonte/Synchro-v4.html) dans l'app de développement (synchro non configurée) :
 * retour texte « Réglages », carte d'état en gris (jamais verte sans cycle complet), titres de section en bas de casse, aucun identifiant
 * interne, largeur de l'iPhone respectée, thème sombre. Les états riches (appareils, conflits, réinitialisation) sont couverts par les
 * tests DOM (`SyncRefonte.test.tsx`) et les e2e Y-IOS-02 avec le simulateur. Projets `pc`, `iphone`, `iphone-webkit`.
 */

const onPhone = (): boolean => test.info().project.name.startsWith('iphone');

test.describe('UI-REFONTE-04 — écran Synchronisation', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : retour « Réglages », carte d'état grise, titres en bas de casse (critères 1, 2, 3)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page);
      await openSyncDetails(page);
      const back = page.getByRole('button', { name: 'Retour à Réglages' });
      await expect(back).toBeVisible();
      await expect(back).toHaveText(/Réglages$/);
      const card = page.locator('.ct-sync__stateCard');
      await expect(card).toBeVisible();
      // Non configurée : jamais le vert (règle 5) ; la phrase d'état est celle de la ligne de Réglages.
      await expect(card).toHaveAttribute('data-tone', /^(neutral|danger)$/);
      await expect(card.locator('[data-testid="sync-status-text"]')).toHaveText('Synchronisation non configurée');
      await expect(page.locator('.ct-sync').getByRole('heading', { level: 2, name: 'ÉTAT' })).toHaveCount(0);
      const headings = await page.locator('.ct-sync h2').allTextContents();
      expect(headings.length).toBeGreaterThan(0);
      for (const heading of headings) expect(heading, 'titre en capitales').not.toMatch(/^[A-ZÉÈÀÂÊÎÔÛÇ’' ]{4,}$/);
      expect(headings).toContain('Appareils');
      // Aucun identifiant d'appareil (UUID) à l'écran.
      await expect(page.locator('.ct-sync')).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/);
      const border = await card.evaluate((node) => getComputedStyle(node).borderTopWidth);
      expect(parseFloat(border)).toBeGreaterThanOrEqual(1.5);
      if (onPhone()) await expectFitsViewport(page, `Synchronisation (${scheme})`);
    });
  }

  test('le bouton « Réglages » ramène à l’accueil de Réglages (critère 1)', async ({ page }) => {
    await openApp(page);
    await openSyncDetails(page);
    await page.getByRole('button', { name: 'Retour à Réglages' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Réglages' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Détails', exact: true })).toBeVisible();
  });
});
