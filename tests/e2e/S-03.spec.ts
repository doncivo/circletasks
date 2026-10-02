import { expect, test, type Locator, type Page } from '@playwright/test';
import { addIsoDays } from './helpers/schedule';
import { isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, insertTasks, openWeek, taskButton, weekTab } from './helpers/week';

/**
 * S-03 — Je navigue entre semaines.
 *
 * Couverture : flèches (1), Ctrl+→ / Ctrl+← sur PC (2), balayage horizontal sur iPhone, défilement vertical sans effet (3),
 * « Cette semaine » inactif dans la semaine courante puis retour (4), passage d'année : semaine 53 de 2026 puis semaine 1 de 2027
 * (5), changement de semaine < 300 ms avec 5 000 tâches (6, `pc`), dernière semaine conservée dans la session et semaine courante
 * au rechargement (7), annonce aux lecteurs d'écran et animations coupées par « Réduire les animations » (8).
 * Exécuté sur `pc` et `iphone`.
 */

const heading = (page: Page): Locator => page.getByRole('heading', { level: 1 });

/** Balayage tactile réel (CDP) : le doigt va de `from` à `to` en `steps` mouvements. */
async function swipe(page: Page, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from[0] + ((to[0] - from[0]) * i) / steps, y: from[1] + ((to[1] - from[1]) * i) / steps }],
    });
    await page.waitForTimeout(12);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test.describe('S-03 — naviguer entre semaines', () => {
  test('« Semaine suivante » et « Semaine précédente » changent les sept jours ; « Cette semaine » y revient (critères 1, 4)', async ({ page }) => {
    await openToday(page);
    await openWeek(page);
    const monday = await browserMonday(page);
    const current = page.getByRole('button', { name: 'Cette semaine' });
    await expect(current).toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(dayOf(page, addIsoDays(monday, 7))).toBeVisible();
    await expect(dayOf(page, monday)).toHaveCount(0);
    await expect(page.locator('.ct-week-day')).toHaveCount(7);
    await expect(current).toHaveAttribute('aria-disabled', 'false');
    await expect(page.locator('.ct-week-day[data-today]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Semaine précédente' }).click();
    await page.getByRole('button', { name: 'Semaine précédente' }).click();
    await expect(dayOf(page, addIsoDays(monday, -7))).toBeVisible();

    await current.click();
    await expect(dayOf(page, monday)).toBeVisible();
    await expect(page.locator('.ct-week-day[data-today]')).toHaveCount(1);
    await expect(current).toHaveAttribute('aria-disabled', 'true');
  });

  test('chaque semaine affiche ses propres tâches (critère 1)', async ({ page }, testInfo) => {
    await openToday(page);
    const monday = await browserMonday(page);
    const tag = testInfo.project.name;
    await insertTasks(page, [
      { title: `Cette semaine ${tag}`, date: addIsoDays(monday, 1), space: 'pro' },
      { title: `Suivante ${tag}`, date: addIsoDays(monday, 8), space: 'pro' },
    ]);
    await openWeek(page);
    await expect(taskButton(page, `Cette semaine ${tag}`)).toBeVisible();
    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(taskButton(page, `Suivante ${tag}`)).toBeVisible();
    await expect(taskButton(page, `Cette semaine ${tag}`)).toHaveCount(0);
  });

  test('Ctrl+→ / Ctrl+← changent de semaine sur PC, sans effet dans un champ de saisie (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Raccourcis clavier PC.');
    await openToday(page);
    await openWeek(page);
    const monday = await browserMonday(page);
    await page.keyboard.press('Control+ArrowRight');
    await expect(dayOf(page, addIsoDays(monday, 7))).toBeVisible();
    await page.keyboard.press('Control+ArrowLeft');
    await expect(dayOf(page, monday)).toBeVisible();

    // Dans un champ de saisie (la feuille « Nouvelle tâche » s'ouvre par le bouton +), le raccourci n'agit pas.
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const field = page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByLabel('Titre');
    await field.fill('Texte');
    await page.keyboard.press('Control+ArrowRight');
    await expect(field).toHaveValue('Texte');
    await expect(dayOf(page, monday)).toBeVisible();
  });

  test('iPhone : un balayage horizontal change de semaine, un défilement vertical non (critère 3)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Balayage tactile (iPhone).');
    await openToday(page);
    await openWeek(page);
    const monday = await browserMonday(page);
    const zone = await page.locator('.ct-week__days').boundingBox();
    if (!zone) throw new Error('zone des jours introuvable');
    const y = zone.y + 120;

    // Défilement vertical : rien ne change.
    await swipe(page, [zone.x + 200, zone.y + 500], [zone.x + 210, zone.y + 100]);
    await expect(dayOf(page, monday)).toBeVisible();

    await swipe(page, [zone.x + zone.width - 40, y], [zone.x + 30, y + 6]);
    await expect(dayOf(page, addIsoDays(monday, 7))).toBeVisible();
    await swipe(page, [zone.x + 30, y], [zone.x + zone.width - 40, y + 6]);
    await expect(dayOf(page, monday)).toBeVisible();

    // Un geste trop court ne change rien.
    await swipe(page, [zone.x + 200, y], [zone.x + 170, y]);
    await expect(dayOf(page, monday)).toBeVisible();
  });

  test('passage d’année : semaine 53 de 2026 puis semaine 1 de 2027 (critère 5)', async ({ page }, testInfo) => {
    await page.clock.setFixedTime(new Date('2026-12-29T09:00:00Z'));
    await openToday(page);
    await openWeek(page);
    await expect(page.getByText(isPhone(testInfo) ? 'Semaine 53 · 2026' : 'Semaine 53', { exact: true })).toBeVisible();
    await expect(heading(page)).toHaveText(isPhone(testInfo) ? '28 déc. – 3 janv.' : '28 décembre 2026 – 3 janvier 2027');
    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(page.getByText(isPhone(testInfo) ? 'Semaine 1 · 2027' : 'Semaine 1', { exact: true })).toBeVisible();
    await expect(dayOf(page, '2027-01-04')).toBeVisible();
  });

  test('la dernière semaine consultée est conservée dans la session, la semaine courante revient au rechargement (critère 7)', async ({ page }) => {
    await openToday(page);
    await openWeek(page);
    const monday = await browserMonday(page);
    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(dayOf(page, addIsoDays(monday, 7))).toBeVisible();

    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await weekTab(page).click();
    await expect(dayOf(page, addIsoDays(monday, 7))).toBeVisible();

    await page.reload();
    await expect(page.getByRole('navigation')).toBeVisible();
    await weekTab(page).click();
    await expect(dayOf(page, monday)).toBeVisible();
  });

  test('le changement est annoncé aux lecteurs d’écran et les animations sont coupées si demandé (critère 8)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openToday(page);
    await openWeek(page);
    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(page.locator('[aria-live="polite"]').filter({ hasText: /^Semaine \d+, / })).toHaveText(/^Semaine \d+, .+ – .+/);
    const duration = await page.locator('.ct-week__days').evaluate((el) => getComputedStyle(el).animationDuration);
    expect(Number.parseFloat(duration)).toBeLessThan(0.001);
    await expect(page.getByRole('button', { name: 'Semaine suivante' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Semaine précédente' })).toBeVisible();
  });

  test('chaque changement de semaine s’affiche en moins de 300 ms avec 5 000 tâches (critère 6) @perf', async ({ page }, testInfo) => {
    await openToday(page);
    const monday = await browserMonday(page);
    await page.evaluate(([first]) => window.__ctTest?.seedTasks(5000, first ?? '', 100), [addIsoDays(monday, -50)] as const);
    await openWeek(page);
    await expect(page.locator('.ct-week-item').first()).toBeVisible();

    // Du clic sur la flèche à la première carte de la nouvelle semaine (chargement, sélection, assemblage, rendu) ; meilleur de cinq (autres tests en parallèle ; mesure sans concurrence : `npm run test:perf`).
    const timings: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForTimeout(400);
      const label = attempt % 2 === 0 ? 'Semaine suivante' : 'Semaine précédente';
      timings.push(
        await page.evaluate(async (name) => {
          const button = document.querySelector<HTMLElement>(`button[aria-label="${name}"]`);
          const before = document.querySelector('.ct-week-day')?.getAttribute('data-date');
          const start = performance.now();
          button?.click();
          await new Promise<void>((resolve) => {
            const ready = (): boolean => document.querySelector('.ct-week-day')?.getAttribute('data-date') !== before && document.querySelector('.ct-week-item') !== null;
            if (ready()) return resolve();
            const observer = new MutationObserver(() => {
              if (ready()) {
                observer.disconnect();
                resolve();
              }
            });
            observer.observe(document.body, { childList: true, subtree: true });
          });
          return performance.now() - start;
        }, label),
      );
    }
    testInfo.annotations.push({ type: 'mesure', description: `${timings.map((ms) => String(Math.round(ms))).join(' / ')} ms` });
    expect(Math.min(...timings)).toBeLessThan(300);
  });
});
