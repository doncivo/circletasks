import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { filterPill } from './helpers/spaces';
import { insertTasks, openReport, tileOf } from './helpers/stats';
import { todayTab } from './helpers/today';

/**
 * H-02 — Je vois mon taux de complétion. Date figée au mer. 23 sept. 2026 : S36 (3 sur 4), S37 (2 sur 2), S38 sans tâche, S39 courante
 * (1 sur 3). Graphique Recharts « TAUX DE COMPLÉTION PAR SEMAINE » du rapport, bulle au survol et au focus, tableau équivalent masqué,
 * recalcul au changement de filtre. Exécuté sur `pc` et `iphone`.
 */
test.describe('H-02 — taux de complétion par semaine', () => {
  const bar = (page: Page, week: string) => page.locator(`.ct-stats__bar[data-week="${week}"]`);

  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
    await insertTasks(page, [
      { title: 'A1', date: '2026-09-01', done: true },
      { title: 'A2', date: '2026-09-02', done: true },
      { title: 'A3', date: '2026-09-03', done: true, space: 'perso' },
      { title: 'A4', date: '2026-09-04' },
      { title: 'B1', date: '2026-09-08', done: true },
      { title: 'B2', date: '2026-09-09', done: true, space: 'perso' },
      { title: 'C1', date: '2026-09-21', done: true },
      { title: 'C2', date: '2026-09-22' },
      { title: 'C3', date: '2026-09-23', space: 'perso' },
      { title: 'Futur', date: '2026-09-28', done: true },
    ]);
    await todayTab(page).click();
  });

  test('critères 1 à 3 : quatre barres S36 à S39, taux et « — », semaine courante repérée, « Mois : 67 % » = tuile « 6 sur 9 »', async ({ page }) => {
    await openReport(page, 'septembre');
    await expect(page.getByRole('heading', { level: 2, name: 'TAUX DE COMPLÉTION PAR SEMAINE' })).toBeVisible();
    const bars = page.locator('.ct-stats__bar');
    await expect(bars).toHaveCount(4);
    await expect(bar(page, '2026-08-31')).toContainText('75 %');
    await expect(bar(page, '2026-09-07')).toContainText('100 %');
    await expect(bar(page, '2026-09-14')).toContainText('—');
    await expect(bar(page, '2026-09-21')).toContainText('33 %');
    await expect(bar(page, '2026-09-21')).toHaveAttribute('data-current', 'true');
    await expect(bar(page, '2026-09-07')).toHaveAttribute('data-current', 'false');
    await expect(page.getByText('S36', { exact: true })).toBeVisible();
    await expect(page.getByText('S39', { exact: true })).toBeVisible();
    await expect(page.getByTestId('month-rate')).toHaveText('Mois : 67 %');
    await expect(tileOf(page, 'Tâches faites : 6 sur 9')).toBeVisible();
  });

  test('critère 2 : la hauteur des barres est proportionnelle au taux (120 px au plus), la semaine vide est en pointillé', async ({ page }) => {
    await openReport(page, 'septembre');
    const height = async (week: string) => (await bar(page, week).locator('.ct-stats__barFill').boundingBox())?.height ?? 0;
    await expect(bar(page, '2026-09-07').locator('.ct-stats__barFill')).toBeVisible();
    // L'animation d'entrée (et la mesure de la largeur) doivent se terminer : on attend la proportion finale, 1 sur 3 = 33 % de 120 px.
    await expect
      .poll(async () => {
        const full = await height('2026-09-07');
        return full > 0 ? Math.round(((await height('2026-09-21')) / full) * 100) : 0;
      })
      .toBe(33);
    expect(await height('2026-09-07')).toBeLessThanOrEqual(120.5);
    await expect(bar(page, '2026-09-14').locator('.ct-stats__barEmpty')).toBeVisible();
  });

  test('critère 5 : la bulle « S37 · 7 sept. – 13 sept. · 2 sur 2 » apparaît au survol (PC) et au focus clavier', async ({ page }, testInfo) => {
    await openReport(page, 'septembre');
    const target = bar(page, '2026-09-07');
    await expect(target).toBeVisible();
    if (testInfo.project.name === 'pc') {
      await target.hover();
      await expect(page.getByRole('tooltip')).toHaveText('S37 · 7 sept. – 13 sept. · 2 sur 2');
      await page.mouse.move(0, 0);
      await expect(page.getByRole('tooltip')).toHaveCount(0);
    } else {
      await target.tap();
      await expect(page.getByRole('tooltip')).toHaveText('S37 · 7 sept. – 13 sept. · 2 sur 2');
    }
    await bar(page, '2026-08-31').focus();
    await expect(page.getByRole('tooltip')).toHaveText('S36 · 31 août – 6 sept. · 3 sur 4');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('tooltip')).toHaveText('S37 · 7 sept. – 13 sept. · 2 sur 2');
  });

  test('critère 6 : Pro puis Perso recalculent les barres', async ({ page }) => {
    await openReport(page, 'septembre');
    await filterPill(page, 'Perso').click();
    await expect(bar(page, '2026-08-31')).toContainText('100 %'); // A3
    await expect(bar(page, '2026-09-07')).toContainText('100 %'); // B2
    await expect(bar(page, '2026-09-21')).toContainText('0 %'); // C3
    await expect(page.getByTestId('month-rate')).toHaveText('Mois : 67 %');
    await filterPill(page, 'Pro').click();
    await expect(bar(page, '2026-08-31')).toContainText('67 %');
    await expect(bar(page, '2026-09-07')).toContainText('100 %');
    await expect(bar(page, '2026-09-21')).toContainText('50 %');
    await expect(page.getByTestId('month-rate')).toHaveText('Mois : 67 %');
  });

  test('critère 8 : tableau équivalent masqué visuellement mais lisible', async ({ page }) => {
    await openReport(page, 'septembre');
    const table = page.getByRole('table', { name: 'Taux de complétion par semaine, en tableau' });
    await expect(table).toHaveCount(1);
    await expect(table.getByRole('row')).toHaveText([
      'Semaine 36 : 75 %, 3 tâches sur 4',
      'Semaine 37 : 100 %, 2 tâches sur 2',
      'Semaine 38 : aucune tâche',
      'Semaine 39 : 33 %, 1 tâche sur 3',
    ]);
  });

  test('critère 4 : un mois passé montre les semaines de ce mois (août : six barres)', async ({ page }) => {
    await insertTasks(page, [{ title: 'Août', date: '2026-08-12', done: true }]);
    await openReport(page, 'septembre');
    await page.getByRole('button', { name: 'Mois précédent' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'août', exact: true })).toBeVisible();
    await expect(page.locator('.ct-stats__bar')).toHaveCount(6);
    await expect(page.getByTestId('month-rate')).toHaveText('Mois : 100 %');
  });

  test('critère 7 : Recharts n’est chargé qu’à l’ouverture du rapport (import dynamique)', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.reload();
    await expect(page.getByRole('navigation')).toBeVisible();
    await insertTasks(page, [{ title: 'A1', date: '2026-09-01', done: true }]);
    await todayTab(page).click();
    expect(requested.filter((url) => /recharts/i.test(url))).toEqual([]);
    await openReport(page, 'septembre');
    await expect(page.locator('.ct-stats__bar')).toHaveCount(4);
    expect(requested.some((url) => /recharts/i.test(url))).toBe(true);
  });
});
