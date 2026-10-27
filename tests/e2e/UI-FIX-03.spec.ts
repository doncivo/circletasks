import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertTasks, openReport } from './helpers/stats';

test('UI-FIX-03 — retour iPhone à gauche et phrases vides lisibles', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 956 });
  await page.clock.setFixedTime(new Date('2026-10-27T10:00:00Z'));
  await openApp(page);
  await insertTasks(page, [{ title: 'Preuve rapport', date: '2026-10-26', done: true }]);
  await openReport(page, 'octobre');
  const back = page.getByRole('button', { name: 'Retour', exact: true });
  const rect = await back.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x + rect!.width).toBeLessThan(100);
  for (const text of ['Aucune routine ce mois-ci', 'Aucun objectif']) {
    const label = page.getByText(text, { exact: true });
    await expect(label).toBeVisible();
    expect(await label.evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  }
  await back.click();
  await expect(page.locator('.ct-stats')).toHaveCount(0);
});
