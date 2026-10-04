import { expect, test, type Page } from '@playwright/test';
import { GOOGLE_ACCOUNT } from '../sim';
import { accountCard, attachSims, openCalendarsScreen, startTestSims, waitUpdated, type TestSims } from './helpers/calendars';
import { addIsoDays } from './helpers/schedule';
import { openToday } from './helpers/today';
import { browserMonday, dayOf, openWeek } from './helpers/week';

/**
 * K-01 — Je connecte Google Calendar (simulateur Google local, aucun compte réel ; la vérification sur le vrai compte attend Ali).
 * Critères couverts ici : 1 à 8 ; ES-06 critères 5 et 6 ; S-05 critère 10 ; A-09 critère 10 (parcours clé 8, partie Google).
 * Exécuté sur `pc` et `iphone`.
 */

let sims: TestSims;

test.describe('K-01 — Google Calendar', () => {
  test.beforeEach(async ({ page }) => {
    sims = await startTestSims();
    await attachSims(page, sims);
    await openToday(page);
  });
  test.afterEach(async () => {
    await sims.close();
  });

  async function connect(page: Page) {
    const week = await browserMonday(page);
    const wednesday = addIsoDays(week, 2);
    sims.google.setEvents([
      { calendarId: GOOGLE_ACCOUNT, id: 'point-client', status: 'confirmed', summary: 'Point client', start: { dateTime: `${wednesday}T08:00:00Z` }, end: { dateTime: `${wednesday}T09:00:00Z` } },
      { calendarId: 'famille@group.calendar.google.com', id: 'sans-titre', status: 'confirmed', start: { date: addIsoDays(week, 3) }, end: { date: addIsoDays(week, 4) } },
    ]);
    await openCalendarsScreen(page);
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    const card = accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT);
    await expect(card).toBeVisible();
    await waitUpdated(card);
    return { card, week, wednesday };
  }

  test('connexion : compte, agendas en Pro, événements dans la Semaine (critères 1, 3, 4, 6 ; S-05 critère 10)', async ({ page }) => {
    const { card, week, wednesday } = await connect(page);
    await expect(card.getByText('Connecté')).toBeVisible();
    await expect(card.getByRole('checkbox', { name: 'Afficher Travail' })).toHaveAttribute('aria-checked', 'true');
    await expect(card.getByRole('combobox', { name: 'Espace de Travail' })).toHaveValue('00000000-0000-4000-8000-000000000001');
    await page.getByRole('button', { name: 'Retour aux réglages' }).click();
    await expect(page.getByRole('button', { name: 'Agendas · Rappels Apple : 2 agendas' })).toBeVisible();

    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' })).toHaveCount(1);
    // Un événement sans titre s'affiche « (Sans titre) ».
    await expect(dayOf(page, addIsoDays(week, 3)).locator('.ct-week-event').filter({ hasText: '(Sans titre)' })).toHaveCount(1);
  });

  test('refus du consentement : « Connexion annulée », rien d’enregistré (critère 2)', async ({ page }) => {
    await openCalendarsScreen(page);
    sims.google.denyNextConsent();
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Connexion annulée');
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Google', exact: true })).toBeEnabled();
  });

  test('espace d’un agenda et « Afficher » : les événements suivent le filtre aussitôt (ES-06 critères 5 et 6, critère 5)', async ({ page }) => {
    const { card, wednesday } = await connect(page);
    await card.getByRole('combobox', { name: 'Espace de Travail' }).selectOption({ label: 'Perso' });
    await expect(card.getByRole('combobox', { name: 'Espace de Travail' })).toHaveValue('00000000-0000-4000-8000-000000000002');
    await page.getByRole('button', { name: 'Retour aux réglages' }).click();
    await openWeek(page);
    const pill = (name: string) => page.getByRole('group', { name: 'Filtre d’espace' }).getByRole('button', { name, exact: true });
    await pill('Pro').click();
    await expect(dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' })).toHaveCount(0);
    await pill('Perso').click();
    await expect(dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' })).toHaveCount(1);
    await pill('Tout').click();

    // Décocher « Afficher » retire l'agenda de toutes les vues.
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await page.getByRole('button', { name: /^Agendas · Rappels Apple :/ }).click();
    await accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT).getByRole('checkbox', { name: 'Afficher Travail' }).click();
    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' })).toHaveCount(0);
  });

  test('jeton révoqué : « Déconnecté », bandeau « Agenda … déconnecté », « Reconnecter » ; événements conservés (critère 7, A-09 critère 10)', async ({ page }) => {
    const { card, wednesday } = await connect(page);
    sims.google.revokeAll();
    await card.getByRole('button', { name: `Actualiser ${GOOGLE_ACCOUNT}` }).click();
    await expect(card.getByText('Déconnecté')).toBeVisible();
    await expect(page.getByText(`Agenda ${GOOGLE_ACCOUNT} déconnecté`)).toBeVisible();
    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event').filter({ hasText: 'Point client' })).toHaveCount(1);
    await expect(page.getByText(`Agenda ${GOOGLE_ACCOUNT} déconnecté`)).toBeVisible();
    await page.getByRole('button', { name: 'Reconnecter' }).click();
    await expect(accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT).getByText('Connecté')).toBeVisible();
    await expect(page.getByText(`Agenda ${GOOGLE_ACCOUNT} déconnecté`)).toHaveCount(0);
  });

  test('suppression avec confirmation : compte et événements disparaissent (critère 8)', async ({ page }) => {
    const { card, wednesday } = await connect(page);
    await card.getByRole('button', { name: `Supprimer le compte ${GOOGLE_ACCOUNT}` }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: `Supprimer le compte ${GOOGLE_ACCOUNT}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    expect(sims.google.log).toContain('POST /revoke');
    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event')).toHaveCount(0);
  });

  test('l’ID client et les jetons n’apparaissent jamais dans la page (critères 3 et 9)', async ({ page }) => {
    await connect(page);
    const html = await page.content();
    expect(html).not.toContain(sims.google.clientId);
    expect(html).not.toContain('sim-refresh-');
    expect(html).not.toContain('sim-access-');
    expect(sims.google.log.every((line) => line.startsWith('GET ') || line.startsWith('POST /token') || line.startsWith('POST /revoke'))).toBe(true);
  });
});
