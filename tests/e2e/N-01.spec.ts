import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { createTask, isPhone } from './helpers/today';

/**
 * N-01 — Je reçois un rappel à l'heure d'une tâche.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris). Le planificateur est le FAUX testé, injecté en développement seulement
 * (`__ctNotificationsFake`, comme `__ctSync`) : il enregistre ce que l'app lui demande de poser. Projet `iphone` : la tâche du jour
 * à 10:00 avec « À l'heure » donne une requête ; la modifier la remplace (même identifiant) ; la terminer l'annule ; une autorisation
 * retirée donne le bandeau, rétablie à la reprise il disparaît ; Réglages > Rappels dit « Planifiés jusqu'au… ». Projet `pc` : un planificateur
 * indisponible reçoit au plus la question de disponibilité, rien ne part, et « Les rappels sont envoyés par l'iPhone » est affiché.
 * Le bandeau après réouverture de la page est vérifié en Vitest : la base du navigateur de développement est en mémoire.
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');
const TITLE = 'Appeler le notaire';

interface Request {
  readonly id: string;
  readonly fireAt: string;
  readonly title: string;
  readonly body: string;
  readonly kind: string;
}
interface Hooks {
  readonly calls: { type: string; requests?: Request[] }[];
  setPermission(value: string): void;
}
declare global {
  interface Window {
    __ctNotifications?: Hooks;
    __pcCalls?: string[];
  }
}

const taskRequests = (page: Page): Promise<Request[]> =>
  page.evaluate(() => {
    const replaces = (window.__ctNotifications?.calls ?? []).filter((call) => call.type === 'replace');
    return (replaces.at(-1)?.requests ?? []).filter((request) => request.kind === 'task');
  });

const settingsRow = (page: Page) => page.getByRole('button', { name: /^Récapitulatifs :/ });

async function openReminderSettings(page: Page): Promise<void> {
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
  await settingsRow(page).click();
  await expect(page.getByRole('heading', { name: 'Récapitulatifs' })).toBeVisible();
}

test.describe('N-01 — rappel à l’heure d’une tâche (iPhone, planificateur injecté)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le planificateur injecté représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
  });

  test('créer, modifier, terminer : requête, remplacement, annulation (critère 14)', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await expect.poll(() => taskRequests(page)).toEqual([expect.objectContaining({ title: TITLE, fireAt: '2026-09-23T10:00', body: 'À l’heure' })]);
    const [created] = await taskRequests(page);

    // Modifier : une avance de 30 min s'ajoute, la requête de 10:00 garde son identifiant.
    await page.getByRole('button', { name: TITLE, exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Détail de la tâche' });
    await detail.getByRole('button', { name: 'Modifier' }).click();
    const edit = page.getByRole('dialog', { name: 'Modifier la tâche' });
    await edit.getByRole('checkbox', { name: '30 min' }).click();
    await edit.getByRole('button', { name: 'Enregistrer' }).click();
    await expect.poll(async () => (await taskRequests(page)).map((request) => request.fireAt)).toEqual(['2026-09-23T09:30', '2026-09-23T10:00']);
    expect((await taskRequests(page)).find((request) => request.fireAt === '2026-09-23T10:00')?.id).toBe(created?.id);

    // Terminer : les requêtes de la tâche sont annulées (le plan ne les contient plus).
    await detail.getByRole('button', { name: 'Marquer comme terminée' }).click();
    await expect.poll(() => taskRequests(page)).toEqual([]);
  });

  test('autorisation retirée : bandeau visible ; rétablie à la reprise : disparu (critères 11 et 14)', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await expect.poll(() => taskRequests(page)).toHaveLength(1);
    const banner = page.locator('.ct-status-banner');
    await expect(banner).toHaveCount(0);

    await page.evaluate(() => window.__ctNotifications?.setPermission('denied'));
    // Retour au premier plan : l'autorisation est relue à chaque passage.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(banner).toContainText('Les notifications sont refusées : les rappels ne sonneront pas');
    // Un nouvel essai tant qu'elle est refusée : toujours visible, rien n'est envoyé.
    const replaces = await page.evaluate(() => window.__ctNotifications?.calls.filter((call) => call.type === 'replace').length);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(banner).toContainText('refusées');
    expect(await page.evaluate(() => window.__ctNotifications?.calls.filter((call) => call.type === 'replace').length)).toBe(replaces);

    await page.evaluate(() => window.__ctNotifications?.setPermission('granted'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(banner).toHaveCount(0);
  });

  test('Réglages > Rappels : « Planifiés jusqu’au » et ligne fixe du fuseau (critère 10, N-06)', async ({ page }) => {
    await openReminderSettings(page);
    await expect(page.getByText(/^Planifiés jusqu’au /)).toBeVisible();
    await expect(page.getByText('Après un changement de fuseau, ouvrez CircleTasks : les rappels sont recalculés à l’ouverture.')).toBeVisible();
  });

  test('autorisation non décidée : invitation, « Autoriser » appelle requestPermission() sur geste (critère 11)', async ({ page }) => {
    await page.evaluate(() => window.__ctNotifications?.setPermission('undetermined'));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const banner = page.locator('.ct-status-banner');
    await expect(banner).toContainText('Autorisez les notifications pour recevoir vos rappels');
    expect(await page.evaluate(() => window.__ctNotifications?.calls.some((call) => call.type === 'requestPermission'))).toBe(false);
    await banner.getByRole('button', { name: 'Autoriser les notifications' }).click();
    await expect(banner).toHaveCount(0);
    expect(await page.evaluate(() => window.__ctNotifications?.calls.filter((call) => call.type === 'requestPermission').length)).toBe(1);
  });
});

test.describe('N-01 — le PC n’émet aucun rappel (critère 13)', () => {
  test('planificateur indisponible : aucun appel de planification, aucun bandeau, mention « envoyés par l’iPhone »', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Projet pc seulement.');
    await page.addInitScript(() => {
      const calls: string[] = [];
      window.__pcCalls = calls;
      const record = (name: string, value: unknown) => (): Promise<unknown> => {
        calls.push(name);
        return Promise.resolve(value);
      };
      (globalThis as { __ctNotifications?: unknown }).__ctNotifications = {
        availability: record('availability', 'unavailable'),
        permission: record('permission', 'denied'),
        requestPermission: record('requestPermission', 'denied'),
        replace: record('replace', { scheduled: 0, cancelled: 0, kept: 0 }),
        cancelAll: record('cancelAll', undefined),
        pending: record('pending', []),
        reservedCount: record('reservedCount', 0),
      };
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await openReminderSettings(page);
    await expect(page.getByText('Les rappels sont envoyés par l’iPhone')).toBeVisible();
    await expect(page.locator('.ct-status-banner')).toHaveCount(0);
    const calls = await page.evaluate(() => window.__pcCalls ?? []);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((name) => name === 'availability')).toBe(true);
  });
});
