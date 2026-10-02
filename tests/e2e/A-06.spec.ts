import { expect, test } from '@playwright/test';
import { createTask, openToday, rowOf } from './helpers/today';

/**
 * A-06 — Je replie la liste en vue compacte.
 *
 * Couverture : bouton « Vue compacte » (aria-pressed), une ligne par élément avec heure à droite et
 * sous-lignes masquées (critères 1, 2, 4, 8, Q14), choix conservé au changement d'onglet (5), terminer et
 * mode édition en vue compacte (6). Exécuté sur `pc` et `iphone`. Le redémarrage est couvert par
 * `TodayCompact.test.tsx` (la base du navigateur de développement est en mémoire) ; les écrans Routines et
 * Checklists (critère 7) arrivent avec R-01 et C-01.
 */
test.describe('A-06 — vue compacte', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('replie la liste, affiche l’heure à droite et se rétablit (critères 1, 2, 4, 8)', async ({ page }, testInfo) => {
    const timed = `Facture ${testInfo.project.name}`;
    const plain = `Sans heure ${testInfo.project.name}`;
    await createTask(page, testInfo, { title: timed, time: '09:00' });
    await createTask(page, testInfo, { title: plain });
    const toggle = page.getByRole('button', { name: 'Vue compacte' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(rowOf(page, timed).locator('.ct-list-row__subtitle')).toHaveText('09:00 · Pro');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(rowOf(page, timed).locator('.ct-list-row__subtitle')).toHaveCount(0);
    await expect(rowOf(page, timed).locator('.ct-list-row__time')).toHaveText('09:00');
    await expect(rowOf(page, plain).locator('.ct-list-row__time')).toHaveCount(0);
    const box = await rowOf(page, timed).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.height ?? 999).toBeLessThan(60);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(rowOf(page, timed).locator('.ct-list-row__subtitle')).toHaveText('09:00 · Pro');
  });

  test('le choix est conservé au changement d’onglet ; terminer et mode édition fonctionnent (critères 5, 6)', async ({ page }, testInfo) => {
    const title = `Tâche ${testInfo.project.name}`;
    await createTask(page, testInfo, { title });
    await page.getByRole('button', { name: 'Vue compacte' }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Vue compacte' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).click();
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${title}` })).toBeVisible();
    await page.getByRole('button', { name: 'Mode édition' }).click();
    await expect(page.getByRole('button', { name: `Sélectionner : ${title}` })).toBeVisible();
  });
});
