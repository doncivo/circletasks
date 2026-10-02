import { expect, test } from '@playwright/test';
import { createTask, isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, dayTitles, openWeek, taskButton, weekTab } from './helpers/week';
import { addIsoDays, browserToday } from './helpers/schedule';

/**
 * S-01 — Je vois ma semaine en 7 colonnes (PC) ou 7 sections (iPhone).
 *
 * Couverture : sept jours du lundi au dimanche (1), en-tête « Semaine N » et plage (2), jour courant mis en évidence et
 * annoncé (3), tâches placées par jour avec tri par heure (4, 5), case et fiche détail (7, 8), affichage < 300 ms avec
 * 5 000 tâches (10, `pc`). Exécuté sur `pc` et `iphone`. Les dates sont celles du navigateur (jour courant réel) : la
 * semaine affichée est toujours la semaine courante.
 */
test.describe('S-01 — la semaine en 7 jours', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('sept jours du lundi au dimanche, jour courant seul mis en évidence (critères 1, 2, 3)', async ({ page }, testInfo) => {
    await openWeek(page);
    const monday = await browserMonday(page);
    const today = await browserToday(page);
    const dates = await page.locator('.ct-week-day').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-date')));
    expect(dates).toEqual(Array.from({ length: 7 }, (_, i) => addIsoDays(monday, i)));
    await expect(dayOf(page, monday)).toContainText('LUN.');
    await expect(dayOf(page, addIsoDays(monday, 6))).toContainText('DIM.');

    await expect(page.locator('.ct-week__caption')).toHaveText(isPhone(testInfo) ? /^Semaine \d+ · \d{4}$/ : /^Semaine \d+$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('–');

    await expect(page.locator('.ct-week-day[data-today]')).toHaveCount(1);
    await expect(dayOf(page, today)).toHaveAttribute('data-today', 'true');
    await expect(dayOf(page, today)).toHaveAttribute('aria-current', 'date');
    await expect(page.getByRole('group', { name: /aujourd’hui/ })).toHaveCount(1);

    // Mise en page : colonnes de même largeur sur PC, sections empilées sur iPhone.
    const boxes = await Promise.all(dates.map(async (date) => dayOf(page, date ?? '').boundingBox()));
    if (isPhone(testInfo)) {
      const tops = boxes.map((box) => box?.y ?? 0);
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
      expect(new Set(boxes.map((box) => Math.round(box?.x ?? 0))).size).toBe(1);
    } else {
      expect(new Set(boxes.map((box) => Math.round(box?.y ?? 0))).size).toBe(1);
      const widths = boxes.map((box) => box?.width ?? 0);
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
    }
  });

  test('chaque tâche est dans son jour, triée par heure puis sans heure, terminée à sa place (critères 4, 5, 7)', async ({ page }, testInfo) => {
    const tag = testInfo.project.name;
    const monday = await browserMonday(page);
    const wednesday = addIsoDays(monday, 2);
    const names = { late: `Tard ${tag}`, early: `Tôt ${tag}`, plain: `Sans heure ${tag}`, other: `Vendredi ${tag}` };
    await createTask(page, testInfo, { title: names.plain, date: wednesday });
    await createTask(page, testInfo, { title: names.late, date: wednesday, time: '14:00' });
    await createTask(page, testInfo, { title: names.early, date: wednesday, time: '09:00' });
    await createTask(page, testInfo, { title: names.other, date: addIsoDays(monday, 4) });

    await openWeek(page);
    await expect.poll(() => dayTitles(page, wednesday)).toEqual([names.early, names.late, names.plain]);
    expect(await dayTitles(page, addIsoDays(monday, 4))).toEqual([names.other]);

    // La sous-ligne (PC) ou l'heure (iPhone) accompagne le titre.
    const early = taskButton(page, names.early).locator('xpath=ancestor::*[contains(@class,"ct-week-item")][1]');
    await expect(early).toContainText('09:00');

    // Terminer : la tâche reste barrée dans son jour (après les tâches à faire).
    await page.getByRole('checkbox', { name: `Terminer : ${names.early}` }).click();
    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${names.early}` })).toBeVisible();
    await expect(taskButton(page, names.early)).toHaveAttribute('data-done', 'true');
    await expect.poll(() => dayTitles(page, wednesday)).toEqual([names.late, names.plain, names.early]);
  });

  test('un titre ouvre la fiche détail (critère 8)', async ({ page }, testInfo) => {
    const title = `Fiche ${testInfo.project.name}`;
    await createTask(page, testInfo, { title, date: await browserToday(page) });
    await openWeek(page);
    await taskButton(page, title).click();
    if (isPhone(testInfo)) await expect(page.getByRole('dialog')).toBeVisible();
    else await expect(page.getByRole('complementary', { name: 'Détail de la tâche' })).toBeVisible();
  });

  test('la semaine s’affiche en moins de 300 ms avec 5 000 tâches en base (critère 10) @perf', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    await page.evaluate(([first]) => window.__ctTest?.seedTasks(5000, first ?? '', 100), [addIsoDays(monday, -50)] as const);
    // Mesure dans la page : du clic sur l'onglet à la première carte affichée (chargement, sélection, assemblage, rendu). Cinq
    // essais (retour par Réglages et courte pause entre deux) et le meilleur est retenu : les autres tests tournent en parallèle sur
    // la machine ; la mesure sans concurrence est celle de `npm run test:perf`.
    const measure = async (): Promise<number> =>
      page.evaluate(async () => {
        const tab = [...document.querySelectorAll('nav button')].find((button) => button.textContent?.trim() === 'Semaine') as HTMLElement;
        const start = performance.now();
        tab.click();
        await new Promise<void>((resolve) => {
          const check = (): boolean => document.querySelector('.ct-week-item') !== null;
          if (check()) return resolve();
          const observer = new MutationObserver(() => {
            if (check()) {
              observer.disconnect();
              resolve();
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        });
        return performance.now() - start;
      });
    const timings: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      timings.push(await measure());
      await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
      await page.waitForTimeout(400);
    }
    testInfo.annotations.push({ type: 'mesure', description: `${timings.map((ms) => String(Math.round(ms))).join(' / ')} ms` });
    expect(Math.min(...timings)).toBeLessThan(300);
    await weekTab(page).click();
    await expect(page.locator('.ct-week-item').first()).toBeVisible();
  });
});
