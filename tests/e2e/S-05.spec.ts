import { expect, test, type Page } from '@playwright/test';
import { addIsoDays } from './helpers/schedule';
import { isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, insertTasks, localTime, openWeek, seedCalendarAccount, seedExternalEvent, taskButton } from './helpers/week';

/**
 * S-05 — Je vois les événements calendrier dans la semaine (partielle à l'ordre 1 : critères 1 à 9 sur jeu de test ; le critère 10,
 * rafraîchissement depuis Google et iCloud, arrive avec K-01 à K-03).
 *
 * Aucun connecteur n'existe avant M8 : les lignes d'`external_event` et de `calendar_account` sont posées en base par la prise de
 * test du navigateur de développement (`window.__ctTest`, src/db/testHooks.ts). Fuseau du navigateur : Europe/Paris
 * (playwright.config.ts) ; changement de fuseau en cours d'exécution comme dans T-11.
 * Exécuté sur `pc` et `iphone`.
 */

const PARIS = 'Europe/Paris';
const eventButton = (page: Page, title: RegExp | string) => page.locator('.ct-week-event').filter({ hasText: title });

async function installZoneSwitch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function patched(this: Intl.DateTimeFormat) {
      const options = original.call(this);
      const zone = (window as unknown as { __ctZone?: string }).__ctZone;
      return zone ? { ...options, timeZone: zone } : options;
    };
  });
}

test.describe('S-05 — événements calendrier dans la semaine', () => {
  test.beforeEach(async ({ page }) => {
    await installZoneSwitch(page);
    await openToday(page);
    await seedCalendarAccount(page);
  });

  test('l’événement UTC apparaît au bon jour, à l’heure locale, en tête du jour, avec le nom de la source (critères 1, 8)', async ({ page }, testInfo) => {
    const monday = await browserMonday(page);
    const wednesday = addIsoDays(monday, 2);
    const startUtc = `${wednesday}T08:00:00Z`;
    const hour = localTime(startUtc, PARIS);
    await insertTasks(page, [{ title: 'Envoyer la facture', date: wednesday, time: '09:00', space: 'pro' }]);
    await seedExternalEvent(page, { id: 'e1', title: 'Point client', startUtc, endUtc: `${wednesday}T09:00:00Z` });
    await openWeek(page);

    const event = eventButton(page, 'Point client');
    await expect(event).toHaveCount(1);
    await expect(dayOf(page, wednesday).locator('.ct-week-event')).toHaveCount(1);
    await expect(event).toContainText(`${hour}`);
    if (isPhone(testInfo)) await expect(event.locator('svg')).toBeVisible();
    else await expect(event).toContainText('Google Agenda');
    await expect(event).toHaveAttribute('data-source', 'external');
    // Lecture seule, annoncé comme tel : ni case, ni poignée ; en tête du jour, avant la tâche de 09:00.
    await expect(event.getByRole('checkbox')).toHaveCount(0);
    await expect(event).toHaveAccessibleName(/Point client.*Événement, lecture seule/);
    const order = await dayOf(page, wednesday).locator('.ct-week-event, .ct-week-item').evaluateAll((nodes) => nodes.map((node) => node.className.includes('ct-week-event')));
    expect(order).toEqual([true, false]);
    await expect(taskButton(page, 'Envoyer la facture')).toBeVisible();
    // Fond de l'encart externe (PC) : #E3EEF5 ; texte de la source en #1F6698 (contraste AA).
    if (!isPhone(testInfo)) await expect(event).toHaveCSS('background-color', 'rgb(227, 238, 245)');
  });

  test('un clic ouvre une fiche en lecture seule : titre, date, heures de début et de fin, agenda ; aucun champ modifiable (critères 2, 3)', async ({ page }, testInfo) => {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    await seedExternalEvent(page, { id: 'e1', title: 'Point client', startUtc: `${wednesday}T08:00:00Z`, endUtc: `${wednesday}T09:00:00Z` });
    await openWeek(page);
    await eventButton(page, 'Point client').click();
    const detail = isPhone(testInfo) ? page.getByRole('dialog', { name: 'Détail de l’événement' }) : page.getByRole('complementary', { name: 'Détail de l’événement' });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('heading', { name: 'Point client' })).toBeVisible();
    await expect(detail).toContainText(localTime(`${wednesday}T08:00:00Z`, PARIS));
    await expect(detail).toContainText(localTime(`${wednesday}T09:00:00Z`, PARIS));
    await expect(detail).toContainText('Travail · Google Agenda');
    await expect(detail.getByRole('textbox')).toHaveCount(0);
    await expect(detail.getByRole('checkbox')).toHaveCount(0);
    for (const action of ['Reporter', 'Supprimer', 'Dupliquer', 'Terminer']) await expect(detail.getByRole('button', { name: new RegExp(action) })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
  });

  test('une journée entière : sans heure, en premier, sur sa date, sans décalage (critère 4)', async ({ page }) => {
    const monday = await browserMonday(page);
    const thursday = addIsoDays(monday, 3);
    await seedExternalEvent(page, { id: 'e1', title: 'Réunion', startUtc: `${thursday}T08:00:00Z`, endUtc: `${thursday}T09:00:00Z` });
    await seedExternalEvent(page, { id: 'e2', title: 'Congé', startUtc: `${thursday}T00:00:00Z`, endUtc: `${addIsoDays(thursday, 1)}T00:00:00Z`, allDay: true });
    await openWeek(page);
    const events = dayOf(page, thursday).locator('.ct-week-event');
    await expect(events).toHaveCount(2);
    await expect(events.first()).toContainText('Congé');
    await expect(events.first()).not.toContainText(/\d\d:\d\d/);
    await expect(events.nth(1)).toContainText('Réunion');
    await expect(dayOf(page, addIsoDays(thursday, -1)).locator('.ct-week-event')).toHaveCount(0);
    await expect(dayOf(page, addIsoDays(thursday, 1)).locator('.ct-week-event')).toHaveCount(0);
  });

  test('un événement de plusieurs jours est affiché sur chaque jour couvert (critère 5)', async ({ page }) => {
    const monday = await browserMonday(page);
    await seedExternalEvent(page, { id: 'e1', title: 'Séminaire', startUtc: `${addIsoDays(monday, 1)}T07:00:00Z`, endUtc: `${addIsoDays(monday, 3)}T15:00:00Z` });
    await openWeek(page);
    for (const offset of [1, 2, 3]) await expect(dayOf(page, addIsoDays(monday, offset)).locator('.ct-week-event', { hasText: 'Séminaire' })).toHaveCount(1);
    for (const offset of [0, 4, 5, 6]) await expect(dayOf(page, addIsoDays(monday, offset)).locator('.ct-week-event')).toHaveCount(0);
  });

  test('le filtre d’espace suit le rattachement de l’agenda ; un agenda libre n’est visible que sous « Tout » (critère 7)', async ({ page }) => {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    const at = (hour: string) => `${wednesday}T${hour}:00:00Z`;
    await seedExternalEvent(page, { id: 'e1', title: 'Agenda travail', startUtc: at('06'), endUtc: at('07'), calendarId: 'pro' });
    await seedExternalEvent(page, { id: 'e2', title: 'Agenda famille', startUtc: at('08'), endUtc: at('09'), calendarId: 'perso' });
    await seedExternalEvent(page, { id: 'e3', title: 'Agenda libre', startUtc: at('10'), endUtc: at('11'), calendarId: 'libre' });
    await openWeek(page);
    await expect(page.locator('.ct-week-event')).toHaveCount(3);
    await page.getByRole('button', { name: 'Pro', exact: true }).click();
    await expect(page.locator('.ct-week-event')).toHaveCount(1);
    await expect(eventButton(page, 'Agenda travail')).toHaveCount(1);
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    await expect(eventButton(page, 'Agenda famille')).toHaveCount(1);
    await expect(page.locator('.ct-week-event')).toHaveCount(1);
    await page.getByRole('button', { name: 'Tout', exact: true }).click();
    await expect(page.locator('.ct-week-event')).toHaveCount(3);
  });

  test('un événement ne se déplace pas : aucune zone « Déposer ici » au glisser (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Glisser à la souris (PC) ; au toucher, l’appui long sur un événement ne saisit rien (test unitaire).');
    const monday = await browserMonday(page);
    const wednesday = addIsoDays(monday, 2);
    await seedExternalEvent(page, { id: 'e1', title: 'Point client', startUtc: `${wednesday}T08:00:00Z`, endUtc: `${wednesday}T09:00:00Z` });
    await openWeek(page);
    const from = await eventButton(page, 'Point client').boundingBox();
    const to = await dayOf(page, addIsoDays(wednesday, 1)).boundingBox();
    if (!from || !to) throw new Error('éléments introuvables');
    await page.mouse.move(from.x + 20, from.y + 10);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + 150, { steps: 10 });
    await expect(page.locator('.ct-week__dropHere')).toHaveCount(0);
    await page.mouse.up();
    await expect(dayOf(page, wednesday).locator('.ct-week-event', { hasText: 'Point client' })).toHaveCount(1);
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('l’heure se recalcule quand le fuseau de l’appareil change (dette T-11)', async ({ page }) => {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    const startUtc = `${wednesday}T08:00:00Z`;
    await seedExternalEvent(page, { id: 'e1', title: 'Point client', startUtc, endUtc: `${wednesday}T09:00:00Z` });
    await openWeek(page);
    await expect(eventButton(page, 'Point client')).toContainText(localTime(startUtc, PARIS));

    await page.evaluate(() => {
      (window as unknown as { __ctZone: string }).__ctZone = 'Pacific/Honolulu';
      window.dispatchEvent(new Event('focus'));
    });
    await expect(eventButton(page, 'Point client')).toContainText(localTime(startUtc, 'Pacific/Honolulu'));
    // 08:00 UTC = 22:00 la veille à Honolulu : l'événement change aussi de jour.
    await expect(dayOf(page, addIsoDays(wednesday, -1)).locator('.ct-week-event', { hasText: 'Point client' })).toHaveCount(1);
    await expect(dayOf(page, wednesday).locator('.ct-week-event')).toHaveCount(0);
  });

  test('un événement d’une autre semaine apparaît en changeant de semaine', async ({ page }) => {
    const monday = await browserMonday(page);
    const nextTuesday = addIsoDays(monday, 8);
    await seedExternalEvent(page, { id: 'e1', title: 'Plus tard', startUtc: `${nextTuesday}T08:00:00Z`, endUtc: `${nextTuesday}T09:00:00Z` });
    await openWeek(page);
    await expect(eventButton(page, 'Plus tard')).toHaveCount(0);
    await page.getByRole('button', { name: 'Semaine suivante' }).click();
    await expect(dayOf(page, nextTuesday).locator('.ct-week-event', { hasText: 'Plus tard' })).toHaveCount(1);
  });
});
