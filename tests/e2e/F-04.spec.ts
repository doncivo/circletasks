import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
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
