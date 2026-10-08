import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import type { FakeFocusEndCall } from './helpers/notifications';
import { createTask, isPhone } from './helpers/today';

/**
 * F-04 — La fin de session me notifie.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris) ; `fastForward` saute le temps sans tic intermédiaire (appareil en veille, app en
 * arrière-plan). Couverture : fin à 25 min exactement (critère 1), son joué une fois et aucune notification Windows (2, vérifié par des
 * espions sur `HTMLMediaElement.play` et `Notification`), interrupteur « Son de fin de session » dans Réglages (3), écran « Session
 * terminée » avec ses trois boutons (4), fin constatée au retour d'arrière-plan (5), session libre sans fin automatique (6), annonce en
 * alerte (10). Planification de la notification iPhone (8, 9) : contrat testé avec le faux planificateur (tests d'intégration). Exécuté
 * sur `pc` et `iphone`.
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');
const TITLE = 'Envoyer la facture';

const session = (page: Page) => page.getByRole('region', { name: 'Session Focus' });
const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));

declare global {
  interface Window {
    __plays: number;
    __notifications: number;
  }
}

async function launch(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  await page.locator('.ct-today__list').getByRole('button', { name: TITLE, exact: true }).click();
  await detail(page)
    .getByRole('button', { name: isPhone(testInfo) ? 'Lancer un Focus' : 'Focus 25 min' })
    .click();
  await expect(session(page)).toBeVisible();
}

test.describe('F-04 — fin de session', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      window.__plays = 0;
      window.__notifications = 0;
      HTMLMediaElement.prototype.play = function play() {
        window.__plays += 1;
        return Promise.resolve();
      };
      const FakeNotification = Object.assign(
        function FakeNotification() {
          window.__notifications += 1;
        },
        {
          permission: 'granted',
          requestPermission: (): Promise<string> => {
            window.__notifications += 1;
            return Promise.resolve('granted');
          },
        },
      );
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true });
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
    await createTask(page, testInfo, { title: TITLE, time: '09:00' });
  });

  test('à 25 min : état « Session terminée », anneau complet, son joué une fois, aucune notification (critères 1, 2, 10)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await page.clock.fastForward('24:30');
    await expect(session(page).getByRole('timer')).toHaveText(/^00:[0-3][0-9]$/);
    expect(await page.evaluate(() => window.__plays)).toBe(0);
    await page.clock.fastForward('00:40');
    await expect(session(page).getByRole('alert')).toHaveText('Session terminée · 25 min');
    await expect(session(page).getByRole('timer')).toHaveText('00:00');
    await expect(session(page).locator('.ct-focus__arc')).toHaveAttribute('stroke-dashoffset', '0');
    await expect.poll(() => page.evaluate(() => window.__plays)).toBe(1);
    expect(await page.evaluate(() => window.__notifications)).toBe(0);
    await page.clock.fastForward('10:00');
    await expect(session(page).getByRole('alert')).toHaveText('Session terminée · 25 min'); // pas de dépassement chronométré
    expect(await page.evaluate(() => window.__plays)).toBe(1);
  });

  test('fin pendant la mise en arrière-plan (saut de 40 min sans tic) : close à son terme, 25 min (critères 1 et 5)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await page.clock.fastForward('40:00');
    await expect(session(page).getByRole('alert')).toHaveText('Session terminée · 25 min');
  });

  test('« Terminer la tâche » termine la tâche et propose Annuler (critère 4)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await page.clock.fastForward('26:00');
    await session(page).getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(session(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(`« ${TITLE} » terminée`);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${TITLE}` })).toBeVisible();
  });

  test('« Une autre session » relance 25 min sur la même tâche (critère 4)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await page.clock.fastForward('26:00');
    await session(page).getByRole('button', { name: 'Une autre session' }).click();
    await expect(session(page).getByText('restantes sur 25 min')).toBeVisible();
    await expect(session(page).getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(session(page).getByRole('alert')).toHaveCount(0);
  });

  test('« Fermer » ferme l’écran et laisse la tâche inchangée (critère 4)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await page.clock.fastForward('26:00');
    await session(page).getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(session(page)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: `Terminer : ${TITLE}` })).toBeVisible();
  });

  test('son désactivé dans Réglages › TÂCHES : la fin est silencieuse mais signalée par le texte (critère 3)', async ({ page }, testInfo) => {
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    const toggle = page.getByRole('switch', { name: 'Son de fin de session' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.getByRole('navigation').getByText('Tâches', { exact: true }).click();
    await launch(page, testInfo);
    await page.clock.fastForward('26:00');
    await expect(session(page).getByRole('alert')).toHaveText('Session terminée · 25 min');
    expect(await page.evaluate(() => window.__plays)).toBe(0);
  });

  test('session libre : aucune fin automatique ni son (critère 6)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await session(page).getByRole('button', { name: 'Libre' }).click();
    await page.clock.fastForward('01:30:00');
    await expect(session(page).getByRole('timer')).toHaveText(/^1:30:0[0-9]$/);
    await expect(session(page).getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => window.__plays)).toBe(0);
  });
});

/**
 * F-04 critère 17 (complément ordre 5) : notification de fin planifiée sur l'iPhone, avec le FAUX `FocusEndScheduler` injecté en
 * développement seulement (`__ctFocusEndFake`). Lancement : appel `schedule` à début + 25 min ; pause : `cancel` ; reprise : `schedule`
 * au nouveau terme ; « Terminer la tâche » : `cancel` ; un échec de planification donne le bandeau de l'écran Focus et la session continue.
 * Le bandeau persistant après rechargement est vérifié en Vitest (la base du navigateur de développement est en mémoire).
 */
test.describe('F-04 — notification de fin planifiée (iPhone, planificateur injecté)', () => {
  const calls = (page: Page): Promise<FakeFocusEndCall[]> =>
    page.evaluate(() => (window.__ctFocusEnd?.calls ?? []).map((call) => ({ type: call.type, sessionId: call.sessionId, ...(call.fireAt ? { fireAt: new Date(call.fireAt).toISOString() } : {}) })));

  /** L'horloge de Playwright court depuis son installation : l'échéance est comparée à la minute. */
  const lateBy = (call: FakeFocusEndCall | undefined, target: string): number | null => (call?.fireAt ? Date.parse(call.fireAt) - Date.parse(target) : null);

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le planificateur injecté représente l’iPhone.');
    await page.addInitScript(() => {
      (globalThis as { __ctFocusEndFake?: boolean }).__ctFocusEndFake = true;
    });
    await page.clock.install({ time: NOW });
    await openApp(page);
    await createTask(page, testInfo, { title: TITLE, time: '09:00' });
  });

  test('lancement, pause, reprise, terminer : schedule à début + 25 min, cancel, schedule au nouveau terme, cancel (critère 17)', async ({ page }, testInfo) => {
    await launch(page, testInfo);
    await expect.poll(async () => (await calls(page)).map((call) => call.type)).toEqual(['schedule']);
    expect(lateBy((await calls(page))[0], '2026-09-23T07:25:00.000Z')).toBeGreaterThanOrEqual(0);
    expect(lateBy((await calls(page))[0], '2026-09-23T07:25:00.000Z')).toBeLessThan(60_000);
    await page.clock.fastForward('05:00');
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    await expect.poll(async () => (await calls(page)).at(-1)?.type).toBe('cancel');
    await page.clock.fastForward('10:00');
    await session(page).getByRole('button', { name: 'Reprendre la session' }).click();
    // Début 09:00 + 25 min + 10 min de pause = 09:35 à Paris.
    await expect.poll(async () => (await calls(page)).at(-1)?.type).toBe('schedule');
    expect(lateBy((await calls(page)).at(-1), '2026-09-23T07:35:00.000Z')).toBeGreaterThanOrEqual(0);
    expect(lateBy((await calls(page)).at(-1), '2026-09-23T07:35:00.000Z')).toBeLessThan(60_000);
    await page.clock.fastForward('26:00');
    await session(page).getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect.poll(async () => (await calls(page)).at(-1)?.type).toBe('cancel');
  });

  test('échec de planification : bandeau sur l’écran Focus, la session continue (critère 15)', async ({ page }, testInfo) => {
    await page.evaluate(() => window.__ctFocusEnd?.failNext(new Error('refusé')));
    await launch(page, testInfo);
    await expect(page.getByText('La notification de fin de session n’a pas pu être planifiée')).toBeVisible();
    await expect(session(page).getByRole('timer')).toBeVisible();
    // Un `schedule` réussi (pause puis reprise) efface le bandeau.
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    await expect(page.getByText('La notification de fin de session n’a pas pu être planifiée')).toHaveCount(0);
  });
});
