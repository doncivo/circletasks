import { expect, test, type Page } from '@playwright/test';
import { GOOGLE_ACCOUNT, type GoogleSimEvent } from '../sim';
import { accountCard, attachSims, openCalendarsScreen, startTestSims, waitUpdated, type TestSims } from './helpers/calendars';
import { addIsoDays, browserToday } from './helpers/schedule';
import { todayTab } from './helpers/today';
import { browserMonday, dayOf, openWeek } from './helpers/week';
import { APP_READY_TIMEOUT_MS } from './helpers/app';

/**
 * K-03 — Mes événements externes se mettent à jour (simulateur Google, horloge du navigateur pilotée par `page.clock` : aucun `sleep` réel).
 * Critères couverts ici : 2, 3, 5, 8, 9 ; les règles fines (15 min, premier plan, verrou, 401) sont dans les tests unitaires du domaine
 * et du planificateur. Exécuté sur `pc` et `iphone`.
 */

let sims: TestSims;

const timed = (id: string, summary: string, day: string, hour: string): GoogleSimEvent => ({ calendarId: GOOGLE_ACCOUNT, id, status: 'confirmed', summary, start: { dateTime: `${day}T${hour}:00Z` }, end: { dateTime: `${day}T${String(Number(hour.slice(0, 2)) + 1).padStart(2, '0')}${hour.slice(2)}:00Z` } });

async function openWithClock(page: Page): Promise<void> {
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
}

test.describe('K-03 — rafraîchissement des agendas externes', () => {
  test.beforeEach(async ({ page }) => {
    sims = await startTestSims();
    await attachSims(page, sims);
    await openWithClock(page);
  });
  test.afterEach(async () => {
    await sims.close();
  });

  async function connect(page: Page, events: GoogleSimEvent[]) {
    sims.google.setEvents(events);
    await openCalendarsScreen(page);
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    const card = accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT);
    await waitUpdated(card);
    return card;
  }

  test('toutes les 15 min au premier plan : un événement ajouté, déplacé et supprimé côté serveur apparaît dans la Semaine, sans doublon (critères 2, 3)', async ({ page }) => {
    const monday = await browserMonday(page);
    const wednesday = addIsoDays(monday, 2);
    const thursday = addIsoDays(monday, 3);
    await connect(page, [timed('point', 'Point client', wednesday, '08:00'), timed('supprime', 'À supprimer', wednesday, '12:00')]);
    await openWeek(page);
    const events = (day: string) => dayOf(page, day).locator('.ct-week-event');
    await expect(events(wednesday)).toHaveCount(2);

    sims.google.setEvents([timed('point', 'Point client', thursday, '08:00'), timed('nouveau', 'Nouveau rendez-vous', wednesday, '14:00')]);
    await page.clock.fastForward('13:00');
    await expect(events(wednesday)).toHaveCount(2);
    await expect(events(wednesday).filter({ hasText: 'Point client' })).toHaveCount(1);

    await page.clock.fastForward('03:00');
    await expect(events(wednesday).filter({ hasText: 'Nouveau rendez-vous' })).toHaveCount(1);
    await expect(events(wednesday).filter({ hasText: 'À supprimer' })).toHaveCount(0);
    await expect(events(wednesday).filter({ hasText: 'Point client' })).toHaveCount(0);
    await expect(events(thursday).filter({ hasText: 'Point client' })).toHaveCount(1);
  });

  test('« Actualiser » relit aussitôt ; « Mis à jour il y a N min » suit l’horloge (critère 8)', async ({ page }) => {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    const card = await connect(page, [timed('point', 'Point client', wednesday, '08:00')]);
    await expect(card.getByText('Mis à jour à l’instant')).toBeVisible();
    await page.clock.fastForward('06:00');
    await expect(card.getByText('Mis à jour il y a 5 min').or(card.getByText('Mis à jour il y a 6 min'))).toBeVisible();
    const before = sims.google.log.length;
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect.poll(() => sims.google.log.length).toBeGreaterThan(before);
    await expect(card.getByText('Mis à jour à l’instant')).toBeVisible();
  });

  test('Aujourd’hui affiche l’événement du jour en bandeau, avec sa source et sans case (critère 9)', async ({ page }) => {
    const today = await browserToday(page);
    await connect(page, [timed('point', 'Point client', today, '08:00')]);
    await todayTab(page).click();
    const band = page.locator('.ct-today-event').filter({ hasText: 'Point client' });
    await expect(band).toHaveCount(1);
    await expect(band).toContainText('Google Agenda');
    await expect(band.getByRole('checkbox')).toHaveCount(0);
  });

  test('panne serveur : « Hors ligne », données gardées ; l’échéance suivante rétablit (critère 5)', async ({ page }) => {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    const card = await connect(page, [timed('point', 'Point client', wednesday, '08:00')]);
    sims.google.failNext({ status: 503, pathPrefix: '/calendar' });
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect(card.getByText('Hors ligne')).toBeVisible();
    await expect(page.locator('.ct-status-banner').filter({ hasText: 'Hors ligne' })).toBeVisible();
    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' })).toHaveCount(1);
    await page.clock.fastForward('16:00');
    await openCalendarsScreen(page);
    await expect(accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT).getByText('Connecté')).toBeVisible();
  });

  test('429 : le délai demandé est respecté, y compris par « Actualiser » (critère 5)', async ({ page }) => {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    const card = await connect(page, [timed('point', 'Point client', wednesday, '08:00')]);
    sims.google.failNext({ status: 429, retryAfterSeconds: 600, pathPrefix: '/calendar' });
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect(card.getByText('Réessai plus tard')).toBeVisible();
    const before = sims.google.log.length;
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await page.clock.fastForward('00:05');
    expect(sims.google.log.length).toBe(before);
    await page.clock.fastForward('10:00');
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect.poll(() => sims.google.log.length).toBeGreaterThan(before);
  });
});
