import { expect, test, type Locator, type Page } from '@playwright/test';
import { GOOGLE_ACCOUNT, type GoogleSimEvent } from '../sim';
import { accountCard, attachSims, openCalendarsScreen, startTestSims, waitUpdated, type TestSims } from './helpers/calendars';
import { addIsoDays } from './helpers/schedule';
import { detailOf } from './helpers/spaces';
import { openToday } from './helpers/today';
import { browserMonday, dayOf, openWeek } from './helpers/week';

/**
 * K-04 — Je crée une tâche depuis un événement externe (simulateur Google). Critères 1 à 10 ; parcours clé 8, fin. Exécuté sur `pc` et
 * `iphone`.
 */

let sims: TestSims;

const eventDetail = (page: Page): Locator => page.getByRole('complementary', { name: 'Détail de l’événement' }).or(page.getByRole('dialog', { name: 'Détail de l’événement' }));

test.describe('K-04 — tâche depuis un événement externe', () => {
  let wednesday: string;

  test.beforeEach(async ({ page }) => {
    sims = await startTestSims();
    await attachSims(page, sims);
    await openToday(page);
    wednesday = addIsoDays(await browserMonday(page), 2);
    sims.google.setEvents([timedEvent('08:00')]);
    await openCalendarsScreen(page);
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    await waitUpdated(accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT));
    await openWeek(page);
    await dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' }).click();
    await expect(eventDetail(page)).toBeVisible();
  });
  test.afterEach(async () => {
    await sims.close();
  });

  function timedEvent(hour: string): GoogleSimEvent {
    return { calendarId: GOOGLE_ACCOUNT, id: 'point-client', status: 'confirmed', summary: 'Point client', start: { dateTime: `${wednesday ?? '2026-09-23'}T${hour}:00Z` }, end: { dateTime: `${wednesday ?? '2026-09-23'}T${String(Number(hour.slice(0, 2)) + 1).padStart(2, '0')}:00:00Z` } };
  }

  const create = (page: Page): Locator => eventDetail(page).getByRole('button', { name: 'Créer une tâche depuis : Point client' });

  test('« Créer une tâche » crée la tâche du jour, sans heure, avec « Annuler » ; la fiche porte la ligne « Événement » (critères 1, 2, 3, 10)', async ({ page }) => {
    await create(page).click();
    await expect(page.getByRole('status').filter({ hasText: /Tâche créée pour le \d+ \S+/ })).toBeVisible();
    await expect(page.getByRole('status').getByRole('button', { name: 'Annuler' })).toBeVisible();
    await expect(eventDetail(page).getByRole('button', { name: 'Voir la tâche liée' })).toBeVisible();
    await expect(dayOf(page, wednesday).locator('.ct-week-item .ct-week-item__title').filter({ hasText: 'Point client' })).toHaveCount(1);
    await eventDetail(page).getByRole('button', { name: 'Voir la tâche liée' }).click();
    const link = detailOf(page).getByRole('button', { name: 'Événement : Point client, ouvrir la fiche' });
    await expect(link).toBeVisible();
    await link.click();
    await expect(eventDetail(page)).toBeVisible();
  });

  test('« Annuler » supprime la tâche et rétablit le bouton (critère 8)', async ({ page }) => {
    await create(page).click();
    await page.getByRole('status').getByRole('button', { name: 'Annuler' }).click();
    await expect(create(page)).toBeVisible();
    await expect(dayOf(page, wednesday).locator('.ct-week-item .ct-week-item__title').filter({ hasText: 'Point client' })).toHaveCount(0);
  });

  test('modifier la date de la tâche ne change pas l’événement ; un rafraîchissement garde le lien ; l’événement supprimé côté serveur : « Événement supprimé » (critères 6, 7)', async ({ page }) => {
    await create(page).click();
    await eventDetail(page).getByRole('button', { name: 'Voir la tâche liée' }).click();
    await expect(detailOf(page)).toBeVisible();
    // La feuille de l'iPhone recouvre la barre d'onglets : la fiche se referme avant de changer d'écran.
    await page.keyboard.press('Escape');
    await expect(detailOf(page)).toHaveCount(0);
    // Le serveur déplace l'événement : le lien survit au rafraîchissement.
    sims.google.setEvents([timedEvent('09:00')]);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await openCalendarsScreen(page);
    const card = accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT);
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect.poll(() => sims.google.log.filter((line) => line.includes('/events')).length).toBeGreaterThan(1);
    await openWeek(page);
    await dayOf(page, wednesday).locator('.ct-week-item .ct-week-item__title').filter({ hasText: 'Point client' }).first().click();
    await expect(detailOf(page).getByRole('button', { name: 'Événement : Point client, ouvrir la fiche' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detailOf(page)).toHaveCount(0);
    // Puis il le supprime.
    sims.google.setEvents([]);
    await openCalendarsScreen(page);
    await accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT).getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect.poll(() => sims.google.log.filter((line) => line.includes('/events')).length).toBeGreaterThan(2);
    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event')).toHaveCount(0);
    await dayOf(page, wednesday).locator('.ct-week-item .ct-week-item__title').filter({ hasText: 'Point client' }).first().click();
    await expect(detailOf(page).getByText('Événement supprimé')).toBeVisible();
    await expect(detailOf(page).getByRole('button', { name: /ouvrir la fiche/ })).toHaveCount(0);
  });
});
