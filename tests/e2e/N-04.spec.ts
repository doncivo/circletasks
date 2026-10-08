import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { isPhone } from './helpers/today';

/**
 * N-04 — Je règle un récapitulatif matin et soir.
 *
 * Couverture : ligne « Récapitulatifs » (07:30 · 21:00 par défaut, QB-09), écran Matin / Soir avec interrupteur et heure 24 h,
 * enregistrement, refus d'un soir qui ne suit pas le matin (la persistance après redémarrage est vérifiée en Vitest : la base du navigateur de développement est en mémoire), mention « Envoyé sur l'iPhone » sur PC.
 * Le contenu des récapitulatifs est vérifié en Vitest. Aucun récapitulatif n'est émis (ordre 5, iPhone seulement).
 * Exécuté sur `pc` et `iphone`.
 */
test.describe('N-04 — récapitulatifs matin et soir', () => {
  async function openSettings(page: Page): Promise<void> {
    await openApp(page);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
  }
  const row = (page: Page) => page.getByRole('button', { name: /^Récapitulatifs :/ });

  test('valeurs par défaut, écran Matin / Soir, enregistrement (critères 1, 2, 3, 9)', async ({ page }, testInfo) => {
    await openSettings(page);
    await expect(page.getByText('RAPPELS', { exact: true })).toBeVisible();
    await expect(row(page)).toContainText('07:30 · 21:00');
    await row(page).click();
    await expect(page.getByRole('heading', { name: 'Récapitulatifs' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Récapitulatif du matin' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Récapitulatif du soir' })).toHaveAttribute('aria-checked', 'true');
    // Critère 7 : « Envoyé sur l'iPhone » sur PC seulement.
    if (isPhone(testInfo)) await expect(page.getByText('Envoyé sur l’iPhone')).toHaveCount(0);
    else await expect(page.getByText('Envoyé sur l’iPhone')).toBeVisible();

    await page.getByLabel('Heure du récapitulatif du matin (HH:MM)').fill('07:00');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page)).toContainText('07:00 · 21:00');

  });

  test('un soir qui ne suit pas le matin est refusé (critère 4)', async ({ page }) => {
    await openSettings(page);
    await row(page).click();
    await page.getByLabel('Heure du récapitulatif du matin (HH:MM)').fill('22:00');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('alert')).toHaveText('L’heure du soir doit suivre celle du matin');
  });

  test('désactiver les deux : « Désactivés » (critère 1)', async ({ page }) => {
    await openSettings(page);
    await row(page).click();
    await page.getByRole('switch', { name: 'Récapitulatif du matin' }).click();
    await page.getByRole('switch', { name: 'Récapitulatif du soir' }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page)).toContainText('Désactivés');
  });
});

/**
 * N-04 critères 10, 12, 13 et 14 (complément ordre 5) : récapitulatifs envoyés sur l'iPhone, avec le FAUX planificateur injecté en
 * développement seulement (`__ctNotificationsFake`). Horloge Playwright : mer. 23 sept. 2026, 09:00 Paris. Projet `iphone`.
 */
test.describe('N-04 — récapitulatifs envoyés sur l’iPhone (planificateur injecté)', () => {
  const NOW = new Date('2026-09-23T09:00:00+02:00');
  async function openSettings(page: Page): Promise<void> {
    await openApp(page);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
  }
  const row = (page: Page) => page.getByRole('button', { name: /^Récapitulatifs :/ });
  const recapRequests = (page: Page) =>
    page.evaluate(() => {
      const hooks = (window as unknown as { __ctNotifications?: { calls: { type: string; requests?: { id: string; fireAt: string; title: string; kind: string }[] }[] } }).__ctNotifications;
      const replaces = (hooks?.calls ?? []).filter((call) => call.type === 'replace');
      return (replaces.at(-1)?.requests ?? []).filter((request) => request.kind === 'recap').map((request) => ({ id: request.id, fireAt: request.fireAt, title: request.title }));
    });

  test('réglages par défaut : le soir d’aujourd’hui puis matin et soir des jours suivants ; changer l’heure du soir replanifie (critères 10 et 13)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le planificateur injecté représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
    });
    await page.clock.install({ time: NOW });
    await openSettings(page);
    await expect.poll(async () => (await recapRequests(page)).slice(0, 3).map((request) => request.id)).toEqual(['recap:evening:2026-09-23', 'recap:morning:2026-09-24', 'recap:evening:2026-09-24']);
    expect((await recapRequests(page)).find((request) => request.id === 'recap:evening:2026-09-23')).toMatchObject({ fireAt: '2026-09-23T21:00', title: 'Tout est fait' });
    // Critère 12 : espace Pro avec plages 20:00–08:00 par défaut, le récapitulatif du soir reste à 21:00.
    await row(page).click();
    await page.getByLabel('Heure du récapitulatif du soir (HH:MM)').fill('22:00');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect.poll(async () => (await recapRequests(page)).find((request) => request.id === 'recap:evening:2026-09-23')?.fireAt).toBe('2026-09-23T22:00');
    // Aucun doublon : un seul récapitulatif du soir pour ce jour.
    expect((await recapRequests(page)).filter((request) => request.id === 'recap:evening:2026-09-23')).toHaveLength(1);
  });

  test('désactiver le soir : plus aucun récapitulatif du soir envoyé (critère 10)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le planificateur injecté représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
    });
    await page.clock.install({ time: NOW });
    await openSettings(page);
    await row(page).click();
    await page.getByRole('switch', { name: 'Récapitulatif du soir' }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect.poll(async () => (await recapRequests(page)).some((request) => request.id.startsWith('recap:evening'))).toBe(false);
    expect((await recapRequests(page)).length).toBeGreaterThan(0);
  });
});
