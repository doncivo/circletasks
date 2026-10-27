import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';

test.use({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true });

for (const mode of ['clair', 'sombre', 'paysage'] as const) {
  test(`UI-REFONTE-01 — ${mode}, création au-dessus du clavier et détail utilisable`, async ({ page }, info) => {
    if (mode === 'paysage') await page.setViewportSize({ width: 956, height: 440 });
    await openApp(page);
    await page.evaluate(({ dark, landscape }) => {
      document.documentElement.style.setProperty('--ct-safe-area-top', landscape ? '0px' : '59px');
      document.documentElement.style.setProperty('--ct-safe-area-bottom', '34px');
      document.documentElement.style.setProperty('--ct-safe-area-left', landscape ? '59px' : '0px');
      document.documentElement.style.setProperty('--ct-safe-area-right', landscape ? '59px' : '0px');
      if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    }, { dark: mode === 'sombre', landscape: mode === 'paysage' });
    // En paysage le layout reste mobile tant que la largeur est inférieure à 1024 px.
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    const title = sheet.getByLabel('Titre');
    await expect(title).toBeFocused();
    const text = 'Préparer la réunion et envoyer le dossier complet à toute l’équipe';
    await title.fill(text);
    const add = sheet.getByRole('button', { name: 'Ajouter la tâche' });
    await expect(add).toBeEnabled();
    await page.evaluate((height) => {
      const viewport = window.visualViewport;
      if (!viewport) throw Error('viewport absent');
      Object.assign(viewport, { height }); viewport.dispatchEvent(new Event('resize'));
    }, mode === 'paysage' ? 240 : 590);
    await expect.poll(async () => {
      const box = await add.boundingBox();
      return box ? box.y + box.height : Infinity;
    }).toBeLessThanOrEqual(mode === 'paysage' ? 240 : 590);
    await expect(sheet.getByRole('button', { name: /Date :/ })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /Heure :/ })).toBeVisible();
    await sheet.getByRole('button', { name: /Plus d.options/ }).click();
    await expect(sheet.getByText('Aucun objectif cette semaine')).toBeVisible();
    await expect(sheet.getByRole('switch', { name: 'Rattacher à mon objectif' })).toHaveCount(0);
    await expect(add).toBeInViewport();
    await sheet.getByRole('button', { name: /Plus d.options/ }).click();
    await page.screenshot({ path: info.outputPath(`nouvelle-tache-${mode}.png`) });
    await add.click();
    await expect(sheet).not.toBeVisible();
    await page.evaluate(() => {
      if (!window.visualViewport) throw Error('viewport absent');
      Object.assign(window.visualViewport, { height: window.innerHeight }); window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.locator('.ct-today__list').getByRole('button', { name: text, exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Détail de la tâche' });
    await expect(detail.getByText('Prévue', { exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Marquer comme terminée' })).toHaveCount(1);
    await expect(detail.getByRole('button', { name: 'Dupliquer la tâche' })).toBeInViewport();
    await expect(detail.getByRole('button', { name: 'Supprimer la tâche' })).toBeInViewport();
    await detail.getByRole('button', { name: 'Reporter', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Demain', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await detail.locator('.ct-task-detail__content').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(detail.getByLabel('Note')).toBeInViewport();
    await expect.poll(() => detail.evaluate((node) => node.scrollTop)).toBe(0);
    const close = await detail.getByRole('button', { name: 'Fermer', exact: true }).boundingBox();
    expect(close?.y).toBeGreaterThanOrEqual(mode === 'paysage' ? 0 : 59);
    await page.screenshot({ path: info.outputPath(`detail-${mode}.png`) });
  });
}
