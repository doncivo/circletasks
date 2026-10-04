import { expect, test, type Page } from '@playwright/test';
import { createTask, isPhone, listTitles, openToday } from './helpers/today';

/**
 * A-02 — Je réordonne ma liste.
 *
 * Couverture : Alt+↑ / Alt+↓ avec focus qui suit et annonce (critère 3), heure prioritaire (5), ordre
 * conservé au changement d'onglet (4), annulation par le bandeau (8), glisser à la souris avec indicateur
 * d'insertion (2, `pc`). Exécuté sur `pc` et `iphone` (clavier). Le glisser tactile par la poignée du mode
 * édition (critère 1) est couvert avec le mode édition dans A-05.spec.ts ; routines, objectif et
 * événements non déplaçables : tests unitaires (aucun de ces modules n'existe encore).
 * La base du navigateur de développement est en mémoire : le redémarrage est couvert par
 * `TodayReorder.test.tsx` (nouvel écran sur la même base).
 */
test.describe('A-02 — réordonner la liste', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  const title = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

  test('Alt+↓ / Alt+↑ déplacent la ligne, le focus la suit, l’annonce est faite (critère 3)', async ({ page }, testInfo) => {
    const [a, b, c] = ['A', 'B', 'C'].map((n) => `${n} ${testInfo.project.name}`) as [string, string, string];
    for (const name of [a, b, c]) await createTask(page, testInfo, { title: name });
    await title(page, a).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => listTitles(page)).toEqual([b, a, c]);
    await expect(title(page, a)).toBeFocused();
    await expect(page.getByTestId('reorder-announcer')).toContainText('Déplacée en position 2 sur 3');
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => listTitles(page)).toEqual([b, c, a]);
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => listTitles(page)).toEqual([b, a, c]);
  });

  test('l’heure prime sur l’ordre manuel (critère 5)', async ({ page }, testInfo) => {
    const tag = testInfo.project.name;
    const names = { nine: `09h ${tag}`, two: `14h ${tag}`, c: `C ${tag}`, d: `D ${tag}` };
    await createTask(page, testInfo, { title: names.nine, time: '09:00' });
    await createTask(page, testInfo, { title: names.two, time: '14:00' });
    await createTask(page, testInfo, { title: names.c });
    await createTask(page, testInfo, { title: names.d });
    await expect.poll(() => listTitles(page)).toEqual([names.nine, names.two, names.c, names.d]);
    await title(page, names.d).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => listTitles(page)).toEqual([names.nine, names.two, names.d, names.c]);
    // D est la première tâche sans heure : elle ne passe pas devant celles à l'heure.
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.getByTestId('reorder-announcer')).toContainText('Position inchangée');
    await expect.poll(() => listTitles(page)).toEqual([names.nine, names.two, names.d, names.c]);
  });

  test('l’ordre est conservé au changement d’onglet, et le déplacement s’annule (critères 4, 8)', async ({ page }, testInfo) => {
    const [a, b] = [`A ${testInfo.project.name}`, `B ${testInfo.project.name}`];
    await createTask(page, testInfo, { title: a });
    await createTask(page, testInfo, { title: b });
    await title(page, b).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => listTitles(page)).toEqual([b, a]);

    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect.poll(() => listTitles(page)).toEqual([b, a]);

    await title(page, a).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => listTitles(page)).toEqual([a, b]);
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(() => listTitles(page)).toEqual([b, a]);
  });

  test('souris : glisser une ligne avec indicateur d’insertion (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Au toucher, le glisser passe par la poignée du mode édition (A-05).');
    const [a, b, c] = ['A', 'B', 'C'].map((n) => `${n} pc`) as [string, string, string];
    for (const name of [a, b, c]) await createTask(page, testInfo, { title: name });
    const rows = page.getByRole('listitem');
    const first = await rows.nth(0).boundingBox();
    const last = await rows.nth(2).boundingBox();
    if (!first || !last) throw new Error('lignes introuvables');
    await page.mouse.move(last.x + 100, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + 100, last.y + last.height / 2 - 20, { steps: 4 });
    await page.mouse.move(first.x + 100, first.y + 4, { steps: 8 });
    await expect(rows.nth(0)).toHaveAttribute('data-drop', 'before');
    await page.mouse.up();
    await expect.poll(() => listTitles(page)).toEqual([c, a, b]);
    // Le glisser ne doit pas avoir ouvert la fiche détail.
    await expect(page.getByRole('complementary', { name: 'Détail de la tâche' })).toHaveCount(0);
  });
});
