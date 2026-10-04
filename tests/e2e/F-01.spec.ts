import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { createTask, isPhone, rowOf } from './helpers/today';

/**
 * F-01 — Je lance une session sur une tâche.
 *
 * Horloge Playwright (mer. 23 sept. 2026, 09:00 Paris). Couverture : bouton de la fiche (« Lancer un Focus » sur iPhone, « Focus 25 min »
 * sur PC, critère 1), écran de session (iPhone) ou panneau flottant (PC dans le navigateur : la vraie mini-fenêtre système n'existe que
 * dans l'app Tauri, couverte par les tests d'intégration), temps restant calculé par horodatage après un saut d'horloge (veille,
 * critères 2 et 5), pastilles de durée (4), « Une session est déjà en cours » (6), croix avec confirmation (7), « Terminer la tâche »
 * avec « Annuler » (8), Ctrl+Maj+F sur la tâche sélectionnée (PC, 3). La reprise après redémarrage (9) et la suppression de la tâche
 * (10) sont des tests d'intégration : la base du navigateur est vide à chaque chargement.
 */
const NOW = new Date('2026-09-23T09:00:00+02:00');
const TITLE = 'Envoyer la facture';

const session = (page: Page) => page.getByRole('region', { name: 'Session Focus' });
const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));
const listTitle = (page: Page, name: string) => page.locator('.ct-today__list').getByRole('button', { name, exact: true });

async function openFocusFromDetail(page: Page, testInfo: { project: { name: string } }, title = TITLE): Promise<void> {
  await listTitle(page, title).click();
  await detail(page)
    .getByRole('button', { name: isPhone(testInfo) ? 'Lancer un Focus' : 'Focus 25 min' })
    .click();
  await expect(session(page)).toBeVisible();
}

test.describe('F-01 — lancer une session Focus', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.clock.install({ time: NOW });
    await openApp(page);
    await createTask(page, testInfo, { title: TITLE, time: '09:00' });
  });

  test('le bouton de la fiche lance la session : 25:00, titre, heure et espace, anneau décoratif (critères 1, 2, 11, 13)', async ({ page }, testInfo) => {
    await openFocusFromDetail(page, testInfo);
    await expect(session(page).getByRole('heading', { name: TITLE })).toBeVisible();
    await expect(session(page)).toContainText('09:00');
    await expect(session(page)).toContainText('Pro');
    await expect(session(page).getByRole('timer')).toHaveText(/^2[45]:[0-9]{2}$/);
    await expect(session(page).getByText('restantes sur 25 min')).toBeVisible();
    await expect(session(page).locator('svg').first()).toHaveAttribute('aria-hidden', 'true');
    await expect(session(page).getByRole('button', { name: '25 min' })).toHaveAttribute('aria-pressed', 'true');
    if (isPhone(testInfo)) {
      const box = await session(page).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(430);
    } else {
      const box = await session(page).boundingBox();
      expect(Math.round(box?.width ?? 0)).toBe(340);
      expect(Math.round(box?.height ?? 0)).toBe(460);
    }
  });

  test('le temps se calcule par horodatage : un saut de 9 min 26 s (veille) donne 15:34 (critères 4 et 5)', async ({ page }, testInfo) => {
    await openFocusFromDetail(page, testInfo);
    await page.clock.fastForward('09:26');
    await expect(session(page).getByRole('timer')).toHaveText(/^15:3[0-4]$/);
    // Nouveau saut de 5 minutes, toujours sans le moindre tic intermédiaire : 10:34 restantes.
    await page.clock.fastForward('05:00');
    await expect(session(page).getByRole('timer')).toHaveText(/^10:(2[6-9]|3[0-4])$/);
  });

  test('les pastilles changent la durée ; Libre compte le temps écoulé (critère 4)', async ({ page }, testInfo) => {
    await openFocusFromDetail(page, testInfo);
    await session(page).getByRole('button', { name: '50 min' }).click();
    await expect(session(page).getByText('restantes sur 50 min')).toBeVisible();
    await expect(session(page).getByRole('button', { name: '50 min' })).toHaveAttribute('aria-pressed', 'true');
    await session(page).getByRole('button', { name: 'Libre' }).click();
    await expect(session(page).getByText('écoulées', { exact: true })).toBeVisible();
    await page.clock.fastForward('12:41');
    await expect(session(page).getByRole('timer')).toHaveText(/^12:4[1-9]$|^12:5[0-9]$/);
  });

  test('la croix demande « Arrêter la session ? » : Continuer garde la session, Arrêter la ferme (critère 7)', async ({ page }, testInfo) => {
    await openFocusFromDetail(page, testInfo);
    await page.clock.fastForward('03:10');
    await session(page).getByRole('button', { name: 'Fermer Focus' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Arrêter la session ?' });
    await expect(dialog.getByRole('button', { name: 'Arrêter et enregistrer 3 min' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Continuer' }).click();
    await expect(session(page)).toBeVisible();
    await session(page).getByRole('button', { name: 'Fermer Focus' }).click();
    await page.getByRole('button', { name: 'Arrêter et enregistrer 3 min' }).click();
    await expect(session(page)).toHaveCount(0);
  });

  test('« Terminer la tâche » ferme l’écran, termine la tâche et propose Annuler ; Annuler rouvre la tâche (critère 8)', async ({ page }, testInfo) => {
    await openFocusFromDetail(page, testInfo);
    await page.clock.fastForward('05:00');
    await session(page).getByRole('button', { name: 'Terminer la tâche' }).click();
    await expect(session(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText(`« ${TITLE} » terminée`);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.getByRole('checkbox', { name: `Terminer : ${TITLE}` })).toBeVisible();
  });

  test('une seule session à la fois : un second lancement affiche « Une session est déjà en cours » (critère 6)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Deuxième lancement par le clavier : PC seulement (l’écran plein couvre la liste sur iPhone).');
    await createTask(page, testInfo, { title: 'Appeler le notaire' });
    await openFocusFromDetail(page, testInfo);
    await rowOf(page, 'Appeler le notaire').getByRole('button', { name: 'Appeler le notaire', exact: true }).focus();
    await page.keyboard.press('Control+Shift+F');
    await expect(page.getByRole('status')).toContainText('Une session est déjà en cours');
    await expect(session(page).getByRole('heading', { name: TITLE })).toBeVisible();
  });

  test('PC : Ctrl+Maj+F lance la session sur la tâche sélectionnée (critère 3)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Raccourci clavier : PC seulement.');
    await rowOf(page, TITLE).getByRole('button', { name: TITLE, exact: true }).focus();
    await page.keyboard.press('Control+Shift+F');
    await expect(session(page).getByRole('heading', { name: TITLE })).toBeVisible();
  });

  test('aucun bouton Focus sur une tâche terminée (critère 1)', async ({ page }) => {
    await page.getByRole('checkbox', { name: `Terminer : ${TITLE}` }).click();
    await listTitle(page, TITLE).click();
    await expect(detail(page)).toBeVisible();
    await expect(detail(page).getByRole('button', { name: /Focus/ })).toHaveCount(0);
  });
});
