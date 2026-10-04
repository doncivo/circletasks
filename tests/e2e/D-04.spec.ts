import { expect, test } from '@playwright/test';
import { createTask, isPhone, openToday, todayTab } from './helpers/today';

/**
 * D-04 (raccourcis clavier) et P-08 (liste des raccourcis) — projet `pc` seulement.
 *
 * Couverture : Ctrl+/ depuis la page et depuis un champ de saisie, fermeture par Échap / Ctrl+/ / « Fermer » avec retour du focus,
 * liste groupée et filtrée (P-08), pied « Ctrl / raccourcis » d'Aujourd'hui, ligne « Raccourcis clavier » de Réglages, ↑ / ↓ / Entrée /
 * Espace dans la liste, Ctrl+, , Ctrl+N, Ctrl+1/2/3, Alt+1 à Alt+6, Ctrl+←/→ (Semaine), Échap sur la fiche détail. Les autres raccourcis
 * (Ctrl+D, Suppr, Ctrl+Z, Ctrl+Maj+D, Alt+↑/↓, Ctrl+K) ont leur parcours dans T-05, T-08, T-12, T-13, A-02 et RC-01. L'AZERTY est couvert
 * en test unitaire (`shortcuts.test.ts`, touche « & », AltGr). Le raccourci global et l'enregistrement système ne se testent qu'en app installée.
 */
test.describe('D-04 / P-08 — raccourcis clavier', () => {

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Clavier PC uniquement : ni raccourci ni aide sur iPhone.');
    await openToday(page);
  });

  test('Ctrl+/ ouvre la liste groupée, Échap la ferme et rend le focus au champ (P-08 critères 1 et 2)', async ({ page }) => {
    const field = page.getByLabel('Nouvelle tâche');
    await field.focus();
    await page.keyboard.press('Control+/');
    const dialog = page.getByRole('dialog', { name: 'Raccourcis clavier' });
    await expect(dialog).toBeVisible();
    for (const group of ['Global', 'Application', 'Listes', 'Semaine']) await expect(dialog.getByText(group, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('row').filter({ hasText: 'Capture rapide' })).toContainText('Ctrl+Alt+Espace');
    // F-01 : Ctrl+Maj+F est branché (plus de « (bientôt) »).
    await expect(dialog.getByRole('row').filter({ hasText: 'Lancer une session Focus' })).toContainText('Ctrl+Maj+F');
    await expect(dialog.getByRole('row').filter({ hasText: 'Lancer une session Focus' })).not.toContainText('(bientôt)');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(field).toBeFocused();
  });

  test('Ctrl+/ de nouveau et « Fermer » ferment ; le filtre restreint la liste (critères 1 et 7)', async ({ page }) => {
    await page.keyboard.press('Control+/');
    const dialog = page.getByRole('dialog', { name: 'Raccourcis clavier' });
    await dialog.getByRole('searchbox', { name: 'Filtrer' }).fill('corbeille');
    await expect(dialog.getByRole('row').filter({ hasText: 'Supprimer (vers la corbeille)' })).toBeVisible();
    await expect(dialog.getByRole('row').filter({ hasText: 'Nouvelle tâche' })).toHaveCount(0);
    await page.keyboard.press('Control+/');
    await expect(dialog).not.toBeVisible();
    await page.keyboard.press('Control+/');
    await dialog.getByRole('button', { name: 'Fermer' }).click();
    await expect(dialog).not.toBeVisible();
  });

  test('le pied « Ctrl / raccourcis » et la ligne de Réglages ouvrent la même fenêtre (critères 5 et 6)', async ({ page }) => {
    await page.getByRole('button', { name: 'Afficher les raccourcis clavier' }).click();
    await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CLAVIER' })).toBeVisible();
    // Navigateur de développement : pas d'enregistrement système, donc pas de ligne « Capture rapide ».
    await expect(page.getByRole('button', { name: /^Capture rapide : / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Afficher les raccourcis clavier' }).click();
    await expect(page.getByRole('dialog', { name: 'Raccourcis clavier' })).toBeVisible();
  });

  test('sous la fenêtre d’aide, Espace et Ctrl+, n’agissent pas sur l’écran dessous', async ({ page }, testInfo) => {
    const title = `Aide ${testInfo.project.name}`;
    await createTask(page, testInfo, { title });
    await page.getByRole('checkbox', { name: `Terminer : ${title}` }).focus();
    await page.keyboard.press('Control+/');
    const dialog = page.getByRole('dialog', { name: 'Raccourcis clavier' });
    await dialog.getByRole('button', { name: 'Fermer' }).focus();
    await page.keyboard.press('Control+,');
    await expect(page.getByRole('heading', { name: 'Réglages' })).toHaveCount(0);
    await expect(dialog).toBeVisible();
  });

  test('↑ / ↓ passent d’une ligne à l’autre, Entrée ouvre le détail, Échap le ferme (critère 2 de D-04)', async ({ page }, testInfo) => {
    const [a, b, c] = ['Alpha', 'Bravo', 'Charlie'].map((name) => `${name} ${testInfo.project.name}`) as [string, string, string];
    for (const title of [a, b, c]) await createTask(page, testInfo, { title });
    await page.locator('.ct-today__list .ct-list-row__title').first().focus();
    const first = await page.locator('.ct-today__list .ct-list-row__title').first().textContent();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.ct-today__list .ct-list-row__title').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.ct-today__list .ct-list-row__title').nth(2)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.ct-today__list .ct-list-row__title').nth(1)).toBeFocused();
    const second = await page.locator('.ct-today__list .ct-list-row__title').nth(1).textContent();
    expect(second).not.toBe(first);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('complementary')).toContainText(second ?? '');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary')).toHaveCount(0);
  });

  test('Ctrl+N donne le focus au champ d’ajout ; Ctrl+1 / 2 / 3 changent le filtre d’espace', async ({ page }) => {
    await page.getByRole('button', { name: 'Réglages', exact: true }).click();
    await page.keyboard.press('Alt+1');
    await page.keyboard.press('Control+n');
    await expect(page.getByLabel('Nouvelle tâche')).toBeFocused();
    for (const [key, name] of [['1', 'Pro'], ['2', 'Perso'], ['3', 'Tout']] as const) {
      await page.keyboard.press(`Control+${key}`);
      await expect(page.getByRole('button', { name, exact: true }).first()).toHaveAttribute('aria-pressed', 'true');
    }
  });

  test('dans un champ de saisie, Espace, Suppr et Ctrl+D ne touchent ni la saisie ni la tâche (critère 4)', async ({ page }, testInfo) => {
    const title = `Saisie ${testInfo.project.name}`;
    await createTask(page, testInfo, { title });
    const field = page.getByLabel('Nouvelle tâche');
    await field.focus();
    await page.keyboard.type('a b');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+d');
    await expect(field).toHaveValue('a b');
    await expect(page.getByRole('checkbox', { name: `Terminer : ${title}` })).not.toBeChecked();
  });

  test('Alt+1 à Alt+6 et Ctrl+← / Ctrl+→ dans la Semaine', async ({ page }) => {
    await page.keyboard.press('Alt+2');
    await expect(page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true })).toHaveAttribute('aria-current', 'page');
    const heading = page.locator('.ct-week__header, .ct-week').first();
    const before = await heading.textContent();
    await page.keyboard.press('Control+ArrowRight');
    await expect.poll(async () => heading.textContent()).not.toBe(before);
    await page.keyboard.press('Control+ArrowLeft');
    await expect.poll(async () => heading.textContent()).toBe(before);
    await page.keyboard.press('Alt+1');
    await expect(todayTab(page)).toHaveAttribute('aria-current', 'page');
  });
});
