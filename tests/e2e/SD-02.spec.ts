import { expect, test } from '@playwright/test';
import { closeSomeday, insertSomeday, openSomeday, somedayButton, somedayList, somedayTitles } from './helpers/someday';
import { isPhone, openToday, todayTab } from './helpers/today';
import { weekTab } from './helpers/week';

/**
 * SD-02 — Je planifie une tâche « Un jour » en un geste. Parcours clé 12 (partie planification) : ligne déployée, « Aujourd'hui »,
 * « Demain », « Choisir une date », message « Annuler ». Exécuté sur `pc` (panneau) et `iphone` (écran plein).
 */
test.describe('SD-02 — planifier une tâche « Un jour »', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await openToday(page);
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }, { title: 'Lire le rapport annuel', space: 'perso' }]);
    // La base du navigateur de développement est en mémoire : Aujourd'hui relit la liste en se remontant.
    await weekTab(page).click();
    await todayTab(page).click();
    await openSomeday(page, testInfo);
  });

  test('toucher une ligne la déploie avec les trois boutons, une seule à la fois (critère 1, 7)', async ({ page }) => {
    const first = somedayList(page).getByRole('button', { name: 'Renouveler le passeport', exact: true });
    await first.click();
    await expect(page.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Planifier demain : Renouveler le passeport' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choisir une date pour : Renouveler le passeport' })).toBeVisible();
    await somedayList(page).getByRole('button', { name: 'Lire le rapport annuel', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Planifier demain : Renouveler le passeport' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Planifier demain : Lire le rapport annuel' })).toBeVisible();
  });

  test('« Aujourd’hui » : la tâche quitte « Un jour », le badge baisse, elle apparaît dans Aujourd’hui (critère 2)', async ({ page }, testInfo) => {
    await somedayList(page).getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
    await page.getByRole('button', { name: 'Planifier aujourd’hui : Renouveler le passeport' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Lire le rapport annuel']);
    await expect(page.getByRole('status')).toContainText('« Renouveler le passeport » planifiée pour aujourd’hui');
    await closeSomeday(page, testInfo);
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
    await expect(page.getByRole('button', { name: 'Renouveler le passeport', exact: true })).toBeVisible();
  });

  test('« Demain » : message « planifiée pour demain », Annuler la remet dans « Un jour » à sa place (critères 3 et 5)', async ({ page }, testInfo) => {
    await somedayList(page).getByRole('button', { name: 'Lire le rapport annuel', exact: true }).click();
    await page.getByRole('button', { name: 'Planifier demain : Lire le rapport annuel' }).click();
    const status = page.getByRole('status');
    await expect(status).toContainText('« Lire le rapport annuel » planifiée pour demain');
    await expect.poll(() => somedayTitles(page)).toEqual(['Renouveler le passeport']);
    // Elle n'est pas dans Aujourd'hui (demain).
    await closeSomeday(page, testInfo);
    await expect(page.getByRole('button', { name: 'Lire le rapport annuel', exact: true })).toHaveCount(0);
    await openSomeday(page, testInfo);
    await status.getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Renouveler le passeport', 'Lire le rapport annuel']);
  });

  test('« Choisir une date » ouvre le sélecteur ; Fermer ne change rien, valider planifie (critère 4)', async ({ page }, testInfo) => {
    await somedayList(page).getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
    await page.getByRole('button', { name: 'Choisir une date pour : Renouveler le passeport' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choisir une date' });
    await expect(dialog).toBeVisible();
    // Échap (PC) ou « Fermer » : rien ne change.
    if (isPhone(testInfo)) await dialog.getByRole('button', { name: 'Fermer' }).click();
    else await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await somedayTitles(page)).toEqual(['Renouveler le passeport', 'Lire le rapport annuel']);

    await page.getByRole('button', { name: 'Choisir une date pour : Renouveler le passeport' }).click();
    if (isPhone(testInfo)) await dialog.getByRole('button', { name: 'Demain' }).click();
    else await dialog.getByRole('textbox', { name: 'Date' }).fill('demain');
    await dialog.getByRole('button', { name: 'Planifier' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => somedayTitles(page)).toEqual(['Lire le rapport annuel']);
    await expect(page.getByRole('status')).toContainText('« Renouveler le passeport » planifiée pour demain');
  });

  test('PC : au clavier, ↑ / ↓ sélectionnent une ligne qui montre ses boutons (critère 1)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Navigation au clavier : PC.');
    await somedayList(page).getByRole('button', { name: 'Renouveler le passeport', exact: true }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Planifier demain : Lire le rapport annuel' })).toBeVisible();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('button', { name: 'Planifier demain : Renouveler le passeport' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Planifier demain : Lire le rapport annuel' })).toHaveCount(0);
  });
});
