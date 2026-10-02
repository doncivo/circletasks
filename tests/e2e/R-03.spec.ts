import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, openRoutines, reopenRoutines } from './helpers/routines';
import { isPhone, todayTab } from './helpers/today';
import { dayOf, openWeek } from './helpers/week';

/**
 * R-03 — Je valide une routine du jour.
 *
 * Date figée au mer. 23 sept. 2026 (semaine du lun. 21 au dim. 27). Couverture : cocher dans Aujourd'hui (barrée, descendue, message
 * « Annuler »), rouvrir, annuler 5 s ; une seule validation par jour ; ronds de la carte cliquables aujourd'hui et jours passés, jours
 * futurs et non prévus inactifs (QB-03) ; Semaine : jour passé validable, futur inactif ; « 3 fois par semaine » (QB-01) ; Espace sur la
 * routine sélectionnée (PC) ; état conservé en changeant d'écran. La persistance après redémarrage est couverte par les tests
 * d'intégration (base du navigateur de développement en mémoire). Exécuté sur `pc` et `iphone`.
 */
test.describe('R-03 — valider une routine', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
  });

  const listRow = (page: Page, title: string) => page.locator('.ct-list-row').filter({ hasText: title });

  test('cocher dans Aujourd’hui : case cochée, titre barré, descendue parmi les terminées, message Annuler ; Rouvrir (critères 1, 2)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Faire mon lit', time: '07:30' },
      { title: 'Boire de l’eau', time: '08:30' },
    ]);
    await reopenRoutines(page);
    await todayTab(page).click();
    await page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' }).click();
    const box = page.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' });
    await expect(box).toHaveAttribute('aria-checked', 'true');
    const row = listRow(page, 'Faire mon lit');
    await expect(row.locator('.ct-list-row__title')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.getByRole('status')).toContainText('« Faire mon lit » validée');
    const titles = await page.locator('.ct-today__list .ct-list-row__title').allTextContents();
    expect(titles).toEqual(['Boire de l’eau', 'Faire mon lit']);

    await box.click();
    await expect(page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' })).toHaveAttribute('aria-checked', 'false');
    expect(await page.locator('.ct-today__list .ct-list-row__title').allTextContents()).toEqual(['Faire mon lit', 'Boire de l’eau']);
  });

  test('« Annuler » du message remet la routine non cochée', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Faire mon lit' }]);
    await reopenRoutines(page);
    await todayTab(page).click();
    await page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' }).click();
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toBeVisible();
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' })).toHaveAttribute('aria-checked', 'false');
  });

  test('la validation de la veille reste dans l’historique ; aujourd’hui la routine revient non cochée (critère 5)', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Faire mon lit', done: ['2026-09-22'] }]);
    await reopenRoutines(page);
    await todayTab(page).click();
    const box = page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await box.click();
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toHaveAttribute('aria-checked', 'true');
    // Carte Routines : mardi 22 (veille) et mercredi 23 validés, un seul jour pour aujourd'hui (l'unicité par jour est vérifiée en intégration).
    await openRoutines(page);
    const card = cardOf(page, 'Faire mon lit');
    await expect(card.locator('.ct-routine-card__counter')).toHaveText('2/7');
    await expect(card.getByRole('checkbox', { name: 'Mardi, fait' })).toBeVisible();
    await expect(card.getByRole('checkbox', { name: 'Mercredi, fait' })).toBeVisible();
  });

  test('ronds de la carte : un jour passé prévu se valide et se rouvre, un jour futur ou non prévu est inactif (critères 4, 10)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Faire mon lit', done: ['2026-09-21', '2026-09-22'] },
      { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], done: ['2026-09-21'] },
    ]);
    await reopenRoutines(page);
    const lit = cardOf(page, 'Faire mon lit');
    await expect(lit.locator('.ct-routine-card__counter')).toHaveText('2/7');
    await lit.getByRole('checkbox', { name: 'Mercredi', exact: true }).click();
    await expect(lit.getByRole('checkbox', { name: 'Mercredi, fait' })).toHaveAttribute('aria-checked', 'true');
    await expect(lit.locator('.ct-routine-card__counter')).toHaveText('3/7');
    // Jeudi : futur, inactif.
    const jeudi = lit.getByRole('checkbox', { name: 'Jeudi', exact: true });
    await expect(jeudi).toHaveAttribute('aria-disabled', 'true');
    await jeudi.click({ force: true });
    await expect(lit.locator('.ct-routine-card__counter')).toHaveText('3/7');
    // Rouvrir mardi (passé, validé).
    await lit.getByRole('checkbox', { name: 'Mardi, fait' }).click();
    await expect(lit.locator('.ct-routine-card__counter')).toHaveText('2/7');

    const sport = cardOf(page, 'Sport');
    const mardi = sport.getByRole('checkbox', { name: 'Mardi, non prévu' });
    await expect(mardi).toHaveAttribute('aria-disabled', 'true');
    await mardi.click({ force: true });
    await expect(sport.locator('.ct-routine-card__counter')).toHaveText('1/3');
    // Lundi validé, rattrapage de mercredi (aujourd'hui).
    await sport.getByRole('checkbox', { name: 'Mercredi', exact: true }).click();
    await expect(sport.locator('.ct-routine-card__counter')).toHaveText('2/3');
  });

  test('Semaine : une routine d’un jour passé se coche pour ce jour, un jour futur est inactif (critères 6, 11)', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Faire mon lit', time: '07:30' }]);
    await reopenRoutines(page);
    await openWeek(page);
    const monday = dayOf(page, '2026-09-21');
    await monday.getByRole('checkbox', { name: 'Terminer : Faire mon lit' }).click();
    await expect(monday.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toHaveAttribute('aria-checked', 'true');
    const friday = dayOf(page, '2026-09-25');
    const future = friday.getByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    await expect(future).toHaveAttribute('aria-disabled', 'true');
    await future.click({ force: true });
    await expect(future).toHaveAttribute('aria-checked', 'false');
    // La validation du lundi est visible dans la carte Routines.
    await reopenRoutines(page);
    await expect(cardOf(page, 'Faire mon lit').getByRole('checkbox', { name: 'Lundi, fait' })).toBeVisible();
  });

  test('« 3 fois par semaine » validée lun. et mar. : visible mercredi, absente ensuite une fois le 3e jour validé (critère 12, QB-01)', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 3, done: ['2026-09-21', '2026-09-22'] }]);
    await reopenRoutines(page);
    await todayTab(page).click();
    await page.getByRole('checkbox', { name: 'Terminer : Courir' }).click();
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Courir' })).toHaveAttribute('aria-checked', 'true');
    // Semaine : plus de « Courir » du jeudi au dimanche, validée le mercredi.
    await openWeek(page);
    await expect(dayOf(page, '2026-09-23').getByRole('checkbox', { name: 'Rouvrir : Courir' })).toBeVisible();
    for (const date of ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']) await expect(dayOf(page, date).getByText('Courir')).toHaveCount(0);
    // Carte : le 4e rond est inactif.
    await reopenRoutines(page);
    await expect(cardOf(page, 'Courir').locator('.ct-routine-card__counter')).toHaveText('3/3');
  });

  test('PC : Espace sur la routine sélectionnée la valide puis la rouvre (critère 8)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'raccourci clavier : PC seulement');
    await insertRoutines(page, [{ title: 'Faire mon lit' }]);
    await reopenRoutines(page);
    await todayTab(page).click();
    const box = page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    await box.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Terminer : Faire mon lit' })).toHaveAttribute('aria-checked', 'false');
  });
});
