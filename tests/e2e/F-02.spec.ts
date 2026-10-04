import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { createTask, isPhone } from './helpers/today';

/**
 * F-02 — Je fais une pause.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris) : `fastForward` saute le temps sans aucun tic intermédiaire, comme une veille.
 * Couverture : « Pause » / « Reprendre » (critères 1 et 2), temps figé et mention « En pause depuis… », temps restant inchangé après la
 * reprise (3), pause qui continue pendant un saut d'horloge (4), arrêt en pause (5), barre d'espace sur la mini-fenêtre (6, test
 * d'intégration : la vraie mini-fenêtre n'existe que dans l'app Tauri), « Toujours en pause ? » après 2 h (7). La restauration après
 * redémarrage est un test d'intégration (la base du navigateur est vide à chaque chargement). Exécuté sur `pc` et `iphone`.
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');
const TITLE = 'Envoyer la facture';

const session = (page: Page) => page.getByRole('region', { name: 'Session Focus' });
const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));
const timer = (page: Page) => session(page).getByRole('timer');

test.describe('F-02 — pause et reprise', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.clock.install({ time: NOW });
    await openApp(page);
    await createTask(page, testInfo, { title: TITLE, time: '09:00' });
    await page.locator('.ct-today__list').getByRole('button', { name: TITLE, exact: true }).click();
    await detail(page)
      .getByRole('button', { name: isPhone(testInfo) ? 'Lancer un Focus' : 'Focus 25 min' })
      .click();
    await expect(session(page)).toBeVisible();
    await page.clock.fastForward('09:26');
    await expect(timer(page)).toHaveText(/^15:3[0-4]$/);
  });

  test('la pause fige le minuteur, affiche « En pause depuis » et propose « Reprendre » (critères 1 et 9)', async ({ page }) => {
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    const frozen = await timer(page).textContent();
    await expect(session(page).getByRole('button', { name: 'Reprendre la session' })).toHaveText('Reprendre');
    await expect(session(page).getByText(/^En pause depuis 00:0\d$/)).toBeVisible();
    await expect(session(page)).toHaveClass(/ct-focus--paused/);
    await expect(session(page).getByText('Session en pause')).toBeAttached();
    // 20 minutes passent d'un coup (veille) : le temps affiché ne bouge pas, la pause continue de se compter (critère 4).
    await page.clock.fastForward('20:00');
    await expect(timer(page)).toHaveText(frozen ?? '');
    await expect(session(page).getByText(/^En pause depuis 20:0\d$/)).toBeVisible();
  });

  test('« Reprendre » repart du même temps restant, la durée prévue n’est pas prolongée (critères 2 et 3)', async ({ page }) => {
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    const frozen = await timer(page).textContent();
    await page.clock.fastForward('10:00');
    await session(page).getByRole('button', { name: 'Reprendre la session' }).click();
    await expect(session(page).getByRole('button', { name: 'Mettre en pause' })).toBeVisible();
    await expect(session(page).getByText('Session reprise')).toBeAttached();
    const [mm, ss] = (frozen ?? '00:00').split(':').map(Number);
    const left = (mm ?? 0) * 60 + (ss ?? 0);
    const after = (await timer(page).textContent()) ?? '00:00';
    const [am, as] = after.split(':').map(Number);
    const afterSeconds = (am ?? 0) * 60 + (as ?? 0);
    expect(left - afterSeconds).toBeLessThanOrEqual(3);
    expect(afterSeconds).toBeLessThanOrEqual(left + 1); // la pause est arrondie à la seconde (F-02 critère 3)
  });

  test('arrêter une session en pause enregistre le temps actif seul : 9 min (critère 5)', async ({ page }) => {
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    await page.clock.fastForward('30:00');
    await session(page).getByRole('button', { name: 'Fermer Focus' }).click();
    await expect(page.getByRole('button', { name: 'Arrêter et enregistrer 9 min' })).toBeVisible();
    await page.getByRole('button', { name: 'Arrêter et enregistrer 9 min' }).click();
    await expect(session(page)).toHaveCount(0);
  });

  test('« Terminer la tâche » en pause termine la tâche (critère 5)', async ({ page }) => {
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    await page.clock.fastForward('02:00');
    await session(page).getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(session(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(`« ${TITLE} » terminée`);
  });

  test('après 2 h de pause : « Toujours en pause ? » avec Reprendre et Arrêter, rien n’est arrêté tout seul (critère 7)', async ({ page }) => {
    await session(page).getByRole('button', { name: 'Mettre en pause' }).click();
    await page.clock.fastForward('02:00:30');
    const group = session(page).getByRole('group', { name: 'Toujours en pause ?' });
    await expect(group).toBeVisible();
    await expect(timer(page)).toHaveText(/^15:3[0-4]$/);
    await group.getByRole('button', { name: 'Reprendre' }).click();
    await expect(session(page).getByRole('button', { name: 'Mettre en pause' })).toBeVisible();
    await expect(group).toHaveCount(0);
  });
});
