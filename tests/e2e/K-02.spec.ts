import { expect, test, type Page } from '@playwright/test';
import { CALDAV_APP_PASSWORD, CALDAV_USER } from '../sim';
import { accountCard, attachSims, openCalendarsScreen, startTestSims, waitUpdated, type TestSims } from './helpers/calendars';
import { addIsoDays } from './helpers/schedule';
import { isPhone, openToday } from './helpers/today';
import { browserMonday, dayOf, openWeek } from './helpers/week';

/**
 * K-02 — Je connecte Apple Calendar (simulateur CalDAV local, aucun compte réel ; la vérification sur le vrai compte iCloud attend Ali).
 * Critères couverts ici : 1 à 8 (parcours clé 8, partie iCloud). Exécuté sur `pc` et `iphone`.
 */

let sims: TestSims;

const ics = (...lines: string[]): string => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CircleTasks//E2E//FR', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const compact = (iso: string): string => iso.replace(/-/g, '');

test.describe('K-02 — Apple Calendar', () => {
  test.beforeEach(async ({ page }) => {
    sims = await startTestSims();
    await attachSims(page, sims);
    await openToday(page);
  });
  test.afterEach(async () => {
    await sims.close();
  });

  async function seedWeek(page: Page): Promise<string> {
    const wednesday = addIsoDays(await browserMonday(page), 2);
    const thursday = addIsoDays(wednesday, 1);
    const utc = `${compact(wednesday)}T170000Z`;
    sims.caldav.setObjects('famille', [
      {
        href: 'diner.ics',
        etag: 'e1',
        startUtc: `${wednesday}T17:00:00Z`,
        endUtc: `${wednesday}T19:00:00Z`,
        ics: ics('BEGIN:VEVENT', 'UID:diner-1', 'DTSTAMP:20260901T000000Z', `DTSTART:${utc}`, `DTEND:${compact(wednesday)}T190000Z`, 'SUMMARY:Dîner chez Leïla', 'END:VEVENT'),
      },
      {
        href: 'annule.ics',
        etag: 'e2',
        startUtc: `${wednesday}T08:00:00Z`,
        endUtc: `${wednesday}T09:00:00Z`,
        ics: ics('BEGIN:VEVENT', 'UID:annule-1', 'DTSTAMP:20260901T000000Z', `DTSTART:${compact(wednesday)}T080000Z`, `DTEND:${compact(wednesday)}T090000Z`, 'STATUS:CANCELLED', 'SUMMARY:Rendez-vous annulé', 'END:VEVENT'),
      },
      {
        href: 'jour.ics',
        etag: 'e3',
        startUtc: `${thursday}T00:00:00Z`,
        endUtc: `${addIsoDays(thursday, 1)}T00:00:00Z`,
        ics: ics('BEGIN:VEVENT', 'UID:jour-1', 'DTSTAMP:20260901T000000Z', `DTSTART;VALUE=DATE:${compact(thursday)}`, `DTEND;VALUE=DATE:${compact(addIsoDays(thursday, 1))}`, 'END:VEVENT'),
      },
    ]);
    return wednesday;
  }

  async function submit(page: Page, username: string, password: string): Promise<void> {
    await page.getByLabel('Identifiant Apple').fill(username);
    await page.getByLabel('Mot de passe d’application').fill(password);
    await page.getByRole('button', { name: 'Se connecter' }).click();
  }

  test('le formulaire explique le mot de passe d’application ; la connexion charge les événements en UTC dans la Semaine (critères 1, 2, 4, 5, 7)', async ({ page }, testInfo) => {
    const wednesday = await seedWeek(page);
    await openCalendarsScreen(page);
    await page.getByRole('button', { name: 'iCloud', exact: true }).click();
    await expect(page.getByText('Utilisez un mot de passe d’application, pas votre mot de passe Apple.')).toBeVisible();
    await expect(page.getByText(/appleid\.apple\.com/)).toBeVisible();
    await submit(page, CALDAV_USER, CALDAV_APP_PASSWORD);

    const card = accountCard(page, 'iCloud', CALDAV_USER);
    await expect(card).toBeVisible();
    await waitUpdated(card);
    // Seul l'agenda d'événements est listé (la liste Rappels est ignorée).
    await expect(card.getByRole('checkbox')).toHaveCount(1);
    await expect(card.getByRole('checkbox', { name: 'Afficher Famille' })).toHaveAttribute('aria-checked', 'true');
    // Formulaire fermé, champ vidé, aucun mot de passe dans la page.
    await expect(page.getByLabel('Mot de passe d’application')).toHaveCount(0);
    expect(await page.content()).not.toContain(CALDAV_APP_PASSWORD);

    await openWeek(page);
    const events = dayOf(page, wednesday).locator('.ct-week-event');
    await expect(events.filter({ hasText: 'Dîner chez Leïla' })).toHaveCount(1);
    // Source « iCloud » (critère 8) : dans la bande sur PC, dans la fiche sur iPhone (la bande n'y montre qu'une icône, S-05).
    if (isPhone(testInfo)) {
      await events.filter({ hasText: 'Dîner chez Leïla' }).click();
      await expect(page.getByRole('dialog', { name: 'Détail de l’événement' })).toContainText('iCloud');
      await page.keyboard.press('Escape');
    } else {
      await expect(events.filter({ hasText: 'iCloud' })).toHaveCount(1);
    }
    await expect(events.filter({ hasText: 'annulé' })).toHaveCount(0);
    await expect(dayOf(page, addIsoDays(wednesday, 1)).locator('.ct-week-event').filter({ hasText: '(Sans titre)' })).toHaveCount(1);
  });

  test('mauvais mot de passe : message, champ vidé, rien d’enregistré (critère 3)', async ({ page }) => {
    await openCalendarsScreen(page);
    await page.getByRole('button', { name: 'iCloud', exact: true }).click();
    await submit(page, CALDAV_USER, 'mauvais-mot-de-passe');
    await expect(page.getByText('Identifiant ou mot de passe d’application incorrect')).toBeVisible();
    await expect(page.getByLabel('Mot de passe d’application')).toHaveValue('');
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
  });

  test('mot de passe révoqué : « Déconnecté », bandeau, « Reconnecter » rouvre le formulaire pré-rempli (critère 6, A-09)', async ({ page }) => {
    await seedWeek(page);
    await openCalendarsScreen(page);
    await page.getByRole('button', { name: 'iCloud', exact: true }).click();
    await submit(page, CALDAV_USER, CALDAV_APP_PASSWORD);
    const card = accountCard(page, 'iCloud', CALDAV_USER);
    await waitUpdated(card);
    sims.caldav.setPassword('nouveau-mot-de-passe');
    await card.getByRole('button', { name: `Actualiser ${CALDAV_USER}` }).click();
    await expect(card.getByText('Déconnecté')).toBeVisible();
    await expect(page.getByText(`Agenda ${CALDAV_USER} déconnecté`)).toBeVisible();
    await page.getByRole('button', { name: 'Reconnecter', exact: true }).first().click();
    const form = page.getByRole('form', { name: 'Compte iCloud' });
    await expect(form.getByLabel('Identifiant Apple')).toHaveValue(CALDAV_USER);
    await form.getByLabel('Mot de passe d’application').fill('nouveau-mot-de-passe');
    await form.getByRole('button', { name: 'Se connecter' }).click();
    await expect(card.getByText('Connecté')).toBeVisible();
    await expect(page.getByText(`Agenda ${CALDAV_USER} déconnecté`)).toHaveCount(0);
  });

  test('suppression : mot de passe oublié, événements retirés (critère 8)', async ({ page }) => {
    const wednesday = await seedWeek(page);
    await openCalendarsScreen(page);
    await page.getByRole('button', { name: 'iCloud', exact: true }).click();
    await submit(page, CALDAV_USER, CALDAV_APP_PASSWORD);
    const card = accountCard(page, 'iCloud', CALDAV_USER);
    await waitUpdated(card);
    await card.getByRole('button', { name: `Supprimer le compte ${CALDAV_USER}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Supprimer' }).click();
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    await openWeek(page);
    await expect(dayOf(page, wednesday).locator('.ct-week-event')).toHaveCount(0);
    expect(sims.caldav.log.every((line) => line.startsWith('PROPFIND ') || line.startsWith('REPORT ') || line.startsWith('GET /.well-known'))).toBe(true);
  });
});
