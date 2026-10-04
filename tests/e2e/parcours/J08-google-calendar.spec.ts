import { expect, test, type Locator, type Page } from '@playwright/test';
import { GOOGLE_ACCOUNT } from '../../sim';
import { accountCard, attachSims, openCalendarsScreen, startTestSims, waitUpdated } from '../helpers/calendars';
import { addIsoDays } from '../helpers/schedule';
import { detailOf } from '../helpers/spaces';
import { openToday } from '../helpers/today';
import { browserMonday, dayOf, openWeek } from '../helpers/week';

/**
 * Parcours clé 8 (PRD 8) : connecter Google Calendar (simulateur local), voir les événements dans la Semaine, créer une tâche liée
 * (K-01, K-04). Interface uniquement ; exécuté sur `pc` et `iphone`.
 */
const eventDetail = (page: Page): Locator => page.getByRole('complementary', { name: 'Détail de l’événement' }).or(page.getByRole('dialog', { name: 'Détail de l’événement' }));

test('parcours 8 : connecter Google, voir l’événement dans la Semaine, créer la tâche liée', async ({ page }) => {
  const sims = await startTestSims();
  try {
    await attachSims(page, sims);
    await openToday(page);
    const wednesday = addIsoDays(await browserMonday(page), 2);
    sims.google.setEvents([
      { calendarId: GOOGLE_ACCOUNT, id: 'point-client', status: 'confirmed', summary: 'Point client', start: { dateTime: `${wednesday}T08:00:00Z` }, end: { dateTime: `${wednesday}T09:00:00Z` } },
    ]);

    // 1. Connexion depuis Réglages › Agendas.
    await openCalendarsScreen(page);
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    const card = accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT);
    await expect(card).toBeVisible();
    await waitUpdated(card);
    await expect(card.getByText('Connecté')).toBeVisible();

    // 2. L'événement apparaît dans la Semaine.
    await openWeek(page);
    const event = dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' });
    await expect(event).toHaveCount(1);

    // 3. Créer une tâche liée depuis l'événement, puis ouvrir sa fiche.
    await event.click();
    await expect(eventDetail(page)).toBeVisible();
    await eventDetail(page).getByRole('button', { name: 'Créer une tâche depuis : Point client' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Tâche créée pour le \d+ \S+/ })).toBeVisible();
    await expect(dayOf(page, wednesday).locator('.ct-week-item .ct-week-item__title').filter({ hasText: 'Point client' })).toHaveCount(1);
    await eventDetail(page).getByRole('button', { name: 'Voir la tâche liée' }).click();
    await expect(detailOf(page).getByRole('button', { name: 'Événement : Point client, ouvrir la fiche' })).toBeVisible();
  } finally {
    await sims.close();
  }
});
