import { expect, test, type Page } from '@playwright/test';
import { GOOGLE_ACCOUNT } from '../sim';
import { accountCard, attachSims, openCalendarsScreen, startTestSims, waitUpdated, type TestSims } from './helpers/calendars';
import { openToday } from './helpers/today';

/**
 * K-TECH-01 critère 7 — connexion Google de l'iPhone : la feuille d'authentification web (plugin Swift) est remplacée, en développement
 * seulement, par le navigateur simulé et le simulateur Google local ; l'échec de la feuille est posé par le test
 * (`window.__ctWebAuthFailure`, lu à chaque connexion). Aucun compte réel. Les parcours de connexion, d'annulation et de jeton révoqué
 * sont ceux de K-01 (même plateforme en mémoire), exécutés eux aussi sur `iphone`. Exécuté sur `pc` et `iphone`.
 */

let sims: TestSims;

const FAILURE = 'La connexion à Google n’a pas pu aboutir.';

async function failSheet(page: Page, code: 'web-auth-failed' | 'web-auth-unavailable' | null): Promise<void> {
  await page.evaluate((value) => {
    (globalThis as { __ctWebAuthFailure?: string | undefined }).__ctWebAuthFailure = value ?? undefined;
  }, code);
}

test.describe('K-TECH-01 — connexion Google sur iPhone', () => {
  test.beforeEach(async ({ page }) => {
    sims = await startTestSims();
    await attachSims(page, sims);
    await openToday(page);
    await openCalendarsScreen(page);
  });
  test.afterEach(async () => {
    await sims.close();
  });

  test('la feuille échoue : message persistant avec le code et « Réessayer », puis la connexion aboutit (critères 4 et 6)', async ({ page }) => {
    await failSheet(page, 'web-auth-failed');
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(FAILURE);
    await expect(alert).toContainText('Code : web-auth-failed');
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    // Aucun appel réseau vers Google n'a eu lieu : la feuille n'a pas abouti.
    expect(sims.google.log.some((line) => line.startsWith('POST /token'))).toBe(false);
    // L'état persiste tant que rien n'a réussi : un autre geste ne l'efface pas.
    await page.getByRole('button', { name: 'iCloud', exact: true }).click();
    await expect(page.getByText(FAILURE)).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();

    await failSheet(page, 'web-auth-unavailable');
    await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await expect(alert).toContainText('Code : web-auth-unavailable');

    await failSheet(page, null);
    await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    const card = accountCard(page, 'Google Agenda', GOOGLE_ACCOUNT);
    await expect(card).toBeVisible();
    await waitUpdated(card);
    await expect(page.getByText(FAILURE)).toHaveCount(0);
  });

  test('l’annulation volontaire efface l’état d’échec (critère 6)', async ({ page }) => {
    await failSheet(page, 'web-auth-failed');
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    await expect(page.getByText(FAILURE)).toBeVisible();
    await failSheet(page, null);
    sims.google.denyNextConsent();
    await page.getByRole('button', { name: 'Réessayer', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Connexion annulée');
    await expect(page.getByText(FAILURE)).toHaveCount(0);
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
  });

  test('« state » falsifié : connexion refusée, aucun compte, aucun échange de code (critère 2)', async ({ page }) => {
    sims.google.forgeNextState();
    await page.getByRole('button', { name: 'Google', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Connexion impossible. Réessayez.');
    await expect(page.getByText('Aucun compte connecté.')).toBeVisible();
    expect(sims.google.log.some((line) => line.startsWith('POST /token'))).toBe(false);
  });
});
