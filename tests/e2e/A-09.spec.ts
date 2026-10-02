import { expect, test } from '@playwright/test';
import { createTask, openToday, rowOf } from './helpers/today';

/**
 * A-09 — Je vois toujours l'état de l'app (partielle à l'ordre 1).
 *
 * Couverture : bandeau « Hors ligne » (role="status") quand le réseau tombe, sans bloquer les actions locales
 * (critère 3), disparition au retour du réseau en moins de 2 s (4), bandeau placé sous l'en-tête sans masquer le
 * champ d'ajout ni le bouton « + » (8). Exécuté sur `pc` et `iphone`.
 *
 * Hors couverture e2e : squelettes au-delà de 150 ms (1, 2, 7 : `TodayLoading.test.tsx`, la base du navigateur de
 * développement répond instantanément), priorité des états (5) et textes des quatre états (6) :
 * `AppStatusBanner.test.tsx`. Critères 9 et 10 (synchro iCloud, agenda déconnecté) : reportés (M15, M8).
 */
test.describe('A-09 — état de l’app', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('« Hors ligne » apparaît sans bloquer l’app, puis disparaît au retour du réseau (critères 3, 4, 8)', async ({ page, context }, testInfo) => {
    await expect(page.getByText('Hors ligne')).toHaveCount(0);
    await context.setOffline(true);
    const banner = page.getByRole('status').filter({ hasText: 'Hors ligne' });
    await expect(banner).toBeVisible();

    // Les actions locales restent possibles, le bandeau ne masque ni le champ d'ajout ni le bouton « + ».
    const title = `Locale ${testInfo.project.name}`;
    await createTask(page, testInfo, { title });
    await expect(rowOf(page, title)).toBeVisible();
    await expect(page.getByLabel('Nouvelle tâche')).toBeAttached();
    await expect(page.getByRole('button', { name: 'Ajouter' })).toBeVisible();
    const bannerBox = await banner.boundingBox();
    const addBox = await page.getByRole('button', { name: 'Ajouter' }).boundingBox();
    expect(bannerBox && addBox && (bannerBox.y + bannerBox.height <= addBox.y || bannerBox.x + bannerBox.width <= addBox.x)).toBe(true);

    await context.setOffline(false);
    await expect(banner).toHaveCount(0, { timeout: 2000 });
  });
});
