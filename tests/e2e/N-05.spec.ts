import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { resumeApp as resume, taskRequests } from './helpers/notifications';
import { createTask, isPhone } from './helpers/today';

/**
 * N-05 — Les rappels survivent au redémarrage.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris). Projet `iphone`, planificateur FAUX injecté en développement seulement
 * (`__ctNotificationsFake`). Critère 1 : le passage `open` part APRÈS l'affichage d'Aujourd'hui et ne le retarde pas (un planificateur dont
 * aucune promesse ne se résout jamais). Critère 8 : le plan suit l'horloge (ouverture, reprise) et ne rattrape jamais une échéance
 * passée. Le rechargement de la page vide la base du navigateur de développement (en mémoire) : le plan reconstruit identique après
 * redémarrage (kept = n, registre perdu ou non) est vérifié en Vitest avec la vraie base (notificationLifecycle.test.ts).
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');

test.describe('N-05 — survie au redémarrage (iPhone, planificateur injecté)', () => {
  // Playwright exige le motif de déstructuration pour le premier argument.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(({}, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le planificateur injecté représente l’iPhone.');
  });

  test('critère 1 : le passage `open` ne retarde pas le premier rendu (aucune promesse du planificateur ne se résout)', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const never = (): Promise<never> => new Promise<never>(() => undefined);
      (globalThis as { __ctNotifications?: unknown }).__ctNotifications = {
        availability: never,
        permission: never,
        requestPermission: never,
        replace: never,
        cancelAll: never,
        pending: never,
        reservedCount: never,
      };
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await createTask(page, testInfo, { title: 'Toujours utilisable', time: '10:00' });
    await expect(page.getByRole('button', { name: 'Toujours utilisable', exact: true })).toBeVisible();
    await expect(page.locator('.ct-status-banner')).toHaveCount(0);
  });

  test('critère 8 : le plan suit l’horloge ; une échéance passée n’est jamais rattrapée ; deux passages sans changement rendent le même plan', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
    for (const [title, time] of [
      ['Premier', '09:30'],
      ['Deuxième', '10:00'],
      ['Troisième', '10:30'],
    ] as const) {
      await createTask(page, testInfo, { title, time });
    }
    await expect.poll(async () => (await taskRequests(page)).map((request) => request.fireAt)).toEqual(['2026-09-23T09:30', '2026-09-23T10:00', '2026-09-23T10:30']);

    // L'horloge avance de 1 h 15 (app en arrière-plan) : à la reprise, les deux premiers rappels, déjà sonnés, sortent du plan.
    await page.clock.fastForward('01:15:00');
    await resume(page);
    await expect.poll(async () => (await taskRequests(page)).map((request) => request.fireAt)).toEqual(['2026-09-23T10:30']);

    const before = await taskRequests(page);
    await resume(page);
    await resume(page);
    expect(await taskRequests(page)).toEqual(before);
  });
});
