import { expect, test, type Page } from '@playwright/test';
import { isPhone, openToday, rowOf } from './helpers/today';

/**
 * Q-01 — mini-fenêtre de capture rapide (projet `pc` seulement).
 *
 * Playwright ne peut ni presser une touche globale ni créer une seconde fenêtre Tauri : la mini-fenêtre est la page `capture.html` d'un second
 * onglet du même navigateur, reliée à l'application par le même protocole que dans l'app installée (`capture:submit`, `capture:done`,
 * `capture:context`) sur un `BroadcastChannel`. L'ouverture par le raccourci système, le placement de la fenêtre, la bascule et le focus rendu
 * à l'application précédente se vérifient à la main (cargo test pour la logique, Ali pour la touche réelle).
 */
test.describe('Q-01 — capture rapide', () => {
  let capture: Page;

  test.beforeEach(async ({ page, context }, testInfo) => {
    test.skip(isPhone(testInfo), 'PC uniquement : le bouton + de l’iPhone existe déjà (Q-05 à l’ordre 5).');
    await context.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['__CT_CAPTURE_CHANNEL__'] = true;
    });
    await openToday(page);
    capture = await context.newPage();
    await capture.setViewportSize({ width: 520, height: 160 });
    await capture.goto('/capture.html');
  });

  const field = (): ReturnType<Page['getByLabel']> => capture.getByLabel('Nouvelle tâche');

  test('fenêtre « Capture rapide », champ focalisé, aide visible, suggestions issues de l’application (critères 1 et 11)', async () => {
    await expect(capture.getByRole('dialog', { name: 'Capture rapide' })).toBeVisible();
    await expect(field()).toBeFocused();
    await expect(capture.getByText('Entrée pour ajouter · Ctrl+Entrée pour enchaîner · Échap pour fermer')).toBeVisible();
    await field().fill('Appeler #');
    // Les espaces viennent de la fenêtre principale (la mini-fenêtre n'ouvre pas la base).
    await expect(capture.getByRole('listbox', { name: 'Suggestions' }).getByRole('option')).toHaveText(['#Pro', '#Perso']);
  });

  test('Entrée : « Acheter du pain #perso » apparaît dans Aujourd’hui sans relancer l’app, la fenêtre se ferme (critères 2 et 5)', async ({ page }) => {
    await field().fill('Acheter du pain #perso');
    await expect(capture.getByRole('group', { name: 'Ce qui sera appliqué' })).toContainText('Perso');
    await field().press('Enter');
    await expect(capture.locator('html')).toHaveAttribute('data-window-state', 'hidden');
    await expect(rowOf(page, 'Acheter du pain')).toBeVisible();
    await expect(rowOf(page, 'Acheter du pain').locator('.ct-list-row__subtitle, .ct-list-row__meta')).toContainText('Perso');
  });

  test('Ctrl+Entrée enchaîne : « Ajoutée : <titre> », champ vidé ; la tâche de demain 10:00 est dans la liste de demain ; Ctrl+Z la retire (critères 3 et 5)', async ({ page }) => {
    await field().fill('Appeler le notaire demain 10h #pro');
    await field().press('Control+Enter');
    await expect(capture.getByText('Ajoutée : Appeler le notaire')).toBeVisible();
    await expect(field()).toHaveValue('');
    await expect(field()).toBeFocused();
    await expect(capture.locator('html')).not.toHaveAttribute('data-window-state', 'hidden');
    // Le message « Annuler » s'affiche 5 s dans la fenêtre principale.
    const undo = page.getByRole('button', { name: 'Annuler', exact: true });
    await expect(undo).toBeVisible();
    // La tâche est datée de demain : elle apparaît dans la liste de demain (sans relancer l'app), avec son heure et son espace.
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    const row = rowOf(page, 'Appeler le notaire');
    await expect(row).toBeVisible();
    await expect(row.locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('10:00 · Pro');
    // Ctrl+Z annule (T-13).
    await page.keyboard.press('Control+z');
    await expect(row).toHaveCount(0);
    // La mini-fenêtre accepte une autre tâche juste après.
    await field().fill('Payer la cantine');
    await field().press('Control+Enter');
    await expect(capture.getByText('Ajoutée : Payer la cantine')).toBeVisible();
  });

  test('Échap ferme sans rien créer ; à la réouverture le champ est vide (critères 4 et 9)', async ({ page }) => {
    await field().fill('Brouillon à ne pas garder');
    await field().press('Escape');
    await expect(capture.locator('html')).toHaveAttribute('data-window-state', 'hidden');
    await expect(rowOf(page, 'Brouillon à ne pas garder')).toHaveCount(0);
    // Réouverture par le raccourci (simulée) : champ vidé et focalisé, aucun brouillon.
    await capture.evaluate(() => window.dispatchEvent(new Event('ct-capture-shown')));
    await expect(capture.locator('html')).toHaveAttribute('data-window-state', 'visible');
    await expect(field()).toHaveValue('');
    await expect(field()).toBeFocused();
  });

  test('titre vide refusé : le champ tremble, la fenêtre reste ouverte, rien n’est créé (critère 6)', async ({ page }) => {
    await field().fill('   ');
    await field().press('Enter');
    await expect(capture.getByText('Saisissez un titre.')).toBeVisible();
    await expect(capture.locator('html')).not.toHaveAttribute('data-window-state', 'hidden');
    await expect(page.locator('.ct-today__list .ct-list-row')).toHaveCount(0);
  });

  test('« #pro » complet : Entrée valide la saisie au lieu de compléter (critère 2)', async ({ page }) => {
    await field().fill('Appeler le notaire #pro');
    await expect(capture.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
    await field().press('Enter');
    await expect(capture.locator('html')).toHaveAttribute('data-window-state', 'hidden');
    await expect(rowOf(page, 'Appeler le notaire')).toBeVisible();
  });

  test('clavier : Tab reste dans la fenêtre ; micro « Dicter » atteignable et nommé (critère 11, Q-03)', async () => {
    await expect(field()).toBeFocused();
    await capture.keyboard.press('Tab');
    await expect(capture.getByRole('button', { name: 'Dicter' })).toBeFocused();
    await capture.keyboard.press('Tab');
    await expect(field()).toBeFocused();
  });
});
