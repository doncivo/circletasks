import { expect, test, type Locator, type Page } from '@playwright/test';
import { addIsoDays, browserToday, dayLabel } from './helpers/schedule';
import { addToSomeday, closeSomeday, openSomeday, somedayButton, somedayTitles } from './helpers/someday';
import { detailOf } from './helpers/spaces';
import { isPhone, openToday, rowOf, todayTab } from './helpers/today';
import { browserMonday, dayOf, openWeek, weekTab } from './helpers/week';

/**
 * Parcours clé 12 (PRD section 8), partie « Un jour » (SD-01 à SD-03, S-06) : ajouter « Renouveler le passeport » sans date, la
 * planifier (PC : glisser vers un jour de la Semaine ; iPhone : « Planifier »), annuler, puis la renvoyer dans « Un jour » depuis sa fiche.
 * La partie objectif est couverte par J12-objectif.spec.ts. Exécuté sur `pc` et `iphone`.
 */
async function mouseDragTo(page: Page, card: Locator, to: Locator): Promise<void> {
  const from = await card.boundingBox();
  const target = await to.boundingBox();
  if (!from || !target) throw new Error('élément introuvable à l’écran');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 - 12, from.y + from.height / 2 + 8, { steps: 3 });
  await page.mouse.move(target.x + target.width / 2, target.y + Math.min(target.height - 8, 120), { steps: 12 });
  await page.mouse.up();
}

test('parcours 12 (Un jour) : ajouter sans date, planifier, annuler, renvoyer dans « Un jour »', async ({ page }, testInfo) => {
  await openToday(page);

  // 1. Ajout sans date depuis l'icône horloge (SD-01) : le badge compte la tâche.
  await openSomeday(page, testInfo);
  await addToSomeday(page, 'Renouveler le passeport');
  await closeSomeday(page, testInfo);
  await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
  await expect(rowOf(page, 'Renouveler le passeport')).toHaveCount(0);

  // 2. Planification : PC = glisser le jeudi de la Semaine (S-06) ; iPhone = « Planifier » (SD-02).
  const monday = await browserMonday(page);
  const target = addIsoDays(monday, 3);
  if (isPhone(testInfo)) {
    await openSomeday(page, testInfo);
    await page.getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
    await page.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual([]);
    await expect(page.getByRole('status')).toContainText('« Renouveler le passeport » planifiée pour aujourd’hui');
    await closeSomeday(page, testInfo);
    await expect(rowOf(page, 'Renouveler le passeport')).toBeVisible();
    await openWeek(page);
    await expect(dayOf(page, await browserToday(page))).toContainText('Renouveler le passeport');
  } else {
    await openWeek(page);
    await page.getByRole('button', { name: /^Un jour/ }).click();
    const panel = page.getByRole('complementary', { name: 'Un jour' });
    const card = panel.locator('[data-drag-id]').filter({ has: page.getByRole('button', { name: 'Renouveler le passeport', exact: true }) });
    await mouseDragTo(page, card, dayOf(page, target));
    await expect(dayOf(page, target)).toContainText('Renouveler le passeport');
    await expect(panel.getByRole('button', { name: 'Renouveler le passeport', exact: true })).toHaveCount(0);
    // Message relatif au jour courant (createTaskUseCases) : le jeudi visé peut être aujourd’hui ou demain.
    const today = await browserToday(page);
    const when =
      target === today ? 'pour aujourd’hui' : target === addIsoDays(today, 1) ? 'pour demain' : `au ${dayLabel(target)}`;
    await expect(page.getByRole('status')).toContainText(`« Renouveler le passeport » planifiée ${when}`);
  }

  // 3. Annuler remet la tâche dans « Un jour ».
  await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
  if (isPhone(testInfo)) await todayTab(page).click(); // l'icône horloge est celle d'Aujourd'hui
  await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');

  // 4. La tâche est planifiée à nouveau, puis renvoyée dans « Un jour » depuis sa fiche (SD-03).
  if (isPhone(testInfo)) {
    await openSomeday(page, testInfo);
    await page.getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
    await page.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' }).click();
    await closeSomeday(page, testInfo);
    await weekTab(page).click();
    await todayTab(page).click();
  } else {
    await mouseDragTo(page, page.getByRole('complementary', { name: 'Un jour' }).locator('[data-drag-id]').first(), dayOf(page, target));
    await expect(dayOf(page, target)).toContainText('Renouveler le passeport');
    await page.getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
    await detailOf(page).getByRole('button', { name: 'Un jour' }).click();
    await expect(page.getByRole('status')).toContainText('« Renouveler le passeport » mise dans « Un jour »');
    await expect(dayOf(page, target)).not.toContainText('Renouveler le passeport');
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
    return;
  }
  await rowOf(page, 'Renouveler le passeport').getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
  await detailOf(page).getByRole('button', { name: 'Un jour' }).click();
  await expect(page.getByRole('status')).toContainText('« Renouveler le passeport » mise dans « Un jour »');
  await detailOf(page).getByRole('button', { name: 'Fermer' }).first().click();
  await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
});
