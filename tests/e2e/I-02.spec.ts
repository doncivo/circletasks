import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { isPhone } from './helpers/today';

/**
 * I-02 — Je suis prévenu avant l'expiration hebdomadaire (critère 11).
 *
 * Projet `iphone` : planificateur et source de signature injectés en développement seulement (`__ctNotificationsFake`, `__ctSigningFake`, les
 * faux testés de src/platform), horloge Playwright (jeu. 8 oct. 2026, 09:00 Paris), reprise simulée par `visibilitychange`. Alerte planifiée
 * pour J+6 à `expiresAt − 24 h`, remplacée après une « actualisation » simulée, bandeau sous 24 h sans notification, date inconnue (dite dans
 * À propos et dans Réglages > Rappels), permission refusée. Projet `pc` : aucune alerte, aucune ligne.
 */
interface SigningHooks {
  source: { reads: number; expireAt(expiresAt: string, issuedAt?: string | null): void; fail(code: string): void };
  alert: { scheduled: { instant: number; zone: string | null; title: string; body: string }[]; pending: unknown; cancels: number };
}

declare global {
  interface Window {
    __ctSigning?: SigningHooks;
  }
}

const NOW = new Date('2026-10-08T09:00:00+02:00');

const resume = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
const signing = <T>(page: Page, run: (hooks: SigningHooks) => T): Promise<T> =>
  page.evaluate(`(${run.toString()})(window.__ctSigning)`) as Promise<T>;

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
}

test.describe('I-02 — alerte avant expiration (iPhone, profil et planificateur injectés)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le profil de signature injecté représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
      (globalThis as { __ctSigningFake?: boolean }).__ctSigningFake = true;
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
  });

  test('J+6 : alerte à expiresAt − 24 h, remplacée après une actualisation, jamais deux fois pour la même échéance (critères 4, 8)', async ({ page }) => {
    await signing(page, (hooks) => hooks.source.expireAt('2026-10-14T07:00:00Z'));
    await resume(page);
    await expect.poll(() => signing(page, (hooks) => hooks.alert.scheduled.length)).toBe(1);
    const [first] = await signing(page, (hooks) => hooks.alert.scheduled);
    expect(first).toMatchObject({ instant: Date.parse('2026-10-13T07:00:00Z'), title: 'CircleTasks va expirer' });
    expect(first?.body).toContain('expiration prévue le mer. 14 oct. à 09:00');
    await resume(page);
    await expect.poll(() => signing(page, (hooks) => hooks.source.reads)).toBeGreaterThanOrEqual(3);
    expect(await signing(page, (hooks) => hooks.alert.scheduled.length)).toBe(1);

    await openSettings(page);
    await expect(page.getByText('Expire le mer. 14 oct. à 09:00 · dans 6 jours')).toBeVisible();
    await expect(page.getByText('Alerte prévue le mar. 13 oct. à 09:00')).toBeVisible();

    // SideStore a actualisé l'app : nouvelle échéance, l'alerte est remplacée.
    await signing(page, (hooks) => hooks.source.expireAt('2026-10-15T07:12:34Z'));
    await resume(page);
    await expect.poll(() => signing(page, (hooks) => hooks.alert.scheduled.length)).toBe(2);
    await expect(page.getByText('Expire le jeu. 15 oct. à 09:12 · dans 7 jours')).toBeVisible();
    expect(await page.locator('.ct-status-banner').count()).toBe(0);
  });

  test('moins de 24 h : aucune notification, bandeau « expire dans 16 h » (critère 6)', async ({ page }) => {
    await signing(page, (hooks) => hooks.source.expireAt('2026-10-08T23:30:00Z'));
    await resume(page);
    await expect(page.locator('.ct-status-banner')).toContainText('CircleTasks expire dans 16 h : actualisez-la dans SideStore');
    expect(await signing(page, (hooks) => hooks.alert.scheduled.length)).toBe(0);
    await openSettings(page);
    await expect(page.getByText('Moins de 24 h restantes : actualisez CircleTasks dans SideStore')).toBeVisible();
  });

  test('signature expirée : bandeau « La signature est expirée : réinstallez l’app »', async ({ page }) => {
    await signing(page, (hooks) => hooks.source.expireAt('2026-10-08T06:00:00Z'));
    await resume(page);
    await expect(page.locator('.ct-status-banner')).toContainText('La signature est expirée : réinstallez l’app');
  });

  test('date inconnue : dite dans À propos et dans Réglages > Rappels (critère 7)', async ({ page }) => {
    await signing(page, (hooks) => hooks.source.fail('profile-unreadable'));
    await resume(page);
    await openSettings(page);
    await expect(page.getByText('Date d’expiration inconnue : l’alerte avant expiration est désactivée')).toBeVisible();
    await expect(page.getByText(/profil de signature illisible/)).toBeVisible();
    await page.getByRole('button', { name: /^Récapitulatifs :/ }).click();
    await expect(page.getByRole('heading', { name: 'Récapitulatifs' })).toBeVisible();
    await expect(page.getByText(/Date d’expiration inconnue : l’alerte avant expiration est désactivée/)).toBeVisible();
    expect(await signing(page, (hooks) => hooks.alert.scheduled.length)).toBe(0);
  });

  test('autorisation refusée : « Les notifications sont refusées : vous ne serez pas prévenu » dans À propos (critère 7)', async ({ page }) => {
    await page.evaluate(() => window.__ctNotifications?.setPermission('denied'));
    await signing(page, (hooks) => hooks.source.expireAt('2026-10-14T07:00:00Z'));
    await resume(page);
    await openSettings(page);
    await expect(page.getByText('Les notifications sont refusées : vous ne serez pas prévenu')).toBeVisible();
    expect(await signing(page, (hooks) => hooks.alert.scheduled.length)).toBe(0);
  });
});

test.describe('I-02 — PC', () => {
  test('aucune alerte ni ligne « Expire le » sur le PC', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Comportement du projet pc.');
    await page.clock.install({ time: NOW });
    await openApp(page);
    await openSettings(page);
    await expect(page.getByText('À PROPOS')).toBeVisible();
    await expect(page.getByText(/Expire le|Date d’expiration inconnue|Lecture de la date/)).toHaveCount(0);
  });
});
