import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { pushAction, requestsOfKind, resumeApp, taskRequests } from './helpers/notifications';
import { createTask, isPhone, rowOf } from './helpers/today';

/**
 * N-03 — Je termine ou reporte depuis la notification.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris). Projet `iphone` : le planificateur et la source des actions sont les FAUX testés,
 * injectés en développement seulement (`__ctNotificationsFake`, `__ctNotificationActionsFake`). `pushAction` joue le plugin Swift qui écrit
 * une ligne dans son fichier et réveille l'app. « Fait » : tâche terminée, message « Annuler » ; « +15 min » : nouvelle requête à +15 min,
 * tâche inchangée. La coupure entre l'écriture de la file et l'acquittement remplace ici « relance de la page » (la base du navigateur de
 * développement est en mémoire : la relance réelle est couverte en Vitest, notificationActions.test.ts, sur la vraie base).
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');
const TITLE = 'Appeler le notaire';

test.describe('N-03 — actions de notification (iPhone, source injectée)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'La source d’actions injectée représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
      (globalThis as { __ctNotificationActionsFake?: boolean }).__ctNotificationActionsFake = true;
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
  });

  test('critère 1 : les catégories sont enregistrées, l’événement n’a que « +15 min », chaque rappel porte sa catégorie', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await expect.poll(() => taskRequests(page)).toHaveLength(1);
    expect((await taskRequests(page))[0]?.category).toBe('task');
    const registered = await page.evaluate(() => window.__ctNotificationActions?.registered.map((type) => [type.id, type.actions.map((action) => `${action.id}:${action.title}`)]));
    expect(registered).toEqual([
      ['ct.task', ['done:Fait', 'snooze15:+15 min']],
      ['ct.routine', ['done:Fait', 'snooze15:+15 min']],
      ['ct.event', ['snooze15:+15 min']],
    ]);
  });

  test('critères 3 et 11 : « Fait » termine la tâche, message « Annuler » ; les rappels de la tâche sortent du plan', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await expect.poll(() => taskRequests(page)).toHaveLength(1);
    const [request] = await taskRequests(page);
    if (request === undefined) throw new Error('requête attendue');

    await pushAction(page, 'done', request.id);

    await expect(page.getByRole('checkbox', { name: `Rouvrir : ${TITLE}` })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('status')).toContainText(`« ${TITLE} » terminée`);
    await expect(page.getByRole('button', { name: 'Annuler' })).toBeVisible();
    await expect.poll(() => taskRequests(page)).toEqual([]);
    // Le fichier natif est acquitté et aucun bandeau n'apparaît.
    expect(await page.evaluate(() => window.__ctNotificationActions?.file.length)).toBe(0);
    await expect(page.locator('.ct-status-banner')).toHaveCount(0);

    // « Annuler » rouvre la tâche (T-04) ; le rappel revient au passage suivant.
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${TITLE}` })).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => taskRequests(page)).toHaveLength(1);
  });

  test('critères 6 et 11 : « +15 min » ajoute une requête à +15 min, la tâche garde son heure, aucun message « Annuler »', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await expect.poll(() => taskRequests(page)).toHaveLength(1);
    const [request] = await taskRequests(page);
    if (request === undefined) throw new Error('requête attendue');

    await pushAction(page, 'snooze15', request.id);

    // L'horloge de la page tourne depuis 09:00:00 : la réponse arrive quelques secondes après, et l'échéance est arrondie à la minute SUIVANTE.
    await expect.poll(async () => (await requestsOfKind(page, 'snooze')).map((snooze) => [snooze.id, snooze.title, snooze.body, snooze.category])).toEqual([[`snooze:${request.id}`, TITLE, 'À l’heure', 'task']]);
    expect((await requestsOfKind(page, 'snooze'))[0]?.fireAt).toMatch(/^2026-09-23T09:1[56]$/);
    // La requête d'origine est inchangée, la tâche garde son heure et reste à faire.
    expect((await taskRequests(page)).map((r) => r.fireAt)).toEqual(['2026-09-23T10:00']);
    await expect(rowOf(page, TITLE)).toContainText('10:00');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${TITLE}` })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(page.locator('.ct-status-banner')).toHaveCount(0);
  });

  test('critère 11 : coupure entre l’écriture de la file et l’acquittement : appliquée une seule fois, état visible puis effacé', async ({ page }, testInfo) => {
    await createTask(page, testInfo, { title: TITLE, time: '10:00' });
    await expect.poll(() => taskRequests(page)).toHaveLength(1);
    const [request] = await taskRequests(page);
    if (request === undefined) throw new Error('requête attendue');

    await page.evaluate(() => window.__ctNotificationActions?.failNext('ack'));
    await pushAction(page, 'snooze15', request.id);

    // La ligne reste dans le fichier (tampon durable), la panne est visible, la répétition est déjà planifiée.
    await expect(page.locator('.ct-status-banner')).toContainText('Les boutons « Fait » et « +15 min » des notifications ne sont pas disponibles');
    await expect.poll(async () => (await requestsOfKind(page, 'snooze')).length).toBe(1);
    expect(await page.evaluate(() => window.__ctNotificationActions?.file.length)).toBe(1);

    // Reprise : la ligne est relue, écartée par clé (aucune seconde répétition), acquittée ; la panne disparaît.
    await resumeApp(page);
    await expect(page.locator('.ct-status-banner')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ctNotificationActions?.file.length)).toBe(0);
    expect(await requestsOfKind(page, 'snooze')).toHaveLength(1);
  });

  test('critère 8 : action dont la cible est introuvable : bandeau persistant et « Ignorer » dans Réglages > Rappels', async ({ page }) => {
    await page.evaluate(() => window.__ctNotificationActions?.push({ numericId: 99_999, actionId: 'done', receivedAtMs: Date.now(), sid: null, deliveredAt: null }));
    const banner = page.locator('.ct-status-banner');
    await expect(banner).toContainText('Une action de notification n’a pas pu être appliquée');

    await banner.getByRole('button', { name: 'Voir le problème de rappels' }).click();
    await expect(page.getByText('Actions en attente d’application : 1 (nouvel essai à chaque ouverture)')).toBeVisible();
    await page.getByRole('button', { name: 'Ignorer les actions de notification en échec' }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByText(/Actions en attente d’application/)).toHaveCount(0);
  });
});

test.describe('N-03 — le PC ne reçoit aucune action', () => {
  test('aucune source d’actions : rien n’est enregistré ni lu, aucun bandeau', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Projet pc seulement.');
    await page.clock.install({ time: NOW });
    await openApp(page);
    await expect(page.locator('.ct-status-banner')).toHaveCount(0);
    expect(await page.evaluate(() => window.__ctNotificationActions === undefined)).toBe(true);
  });
});
