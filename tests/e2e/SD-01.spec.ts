import { expect, test } from '@playwright/test';
import { filterPill } from './helpers/spaces';
import { addToSomeday, closeSomeday, insertSomeday, openSomeday, somedayButton, somedayList, somedayTitles } from './helpers/someday';
import { isPhone, openToday, todayTab } from './helpers/today';

/**
 * SD-01 — J'ajoute une tâche sans date dans « Un jour ». Parcours clé 12 (partie Un jour) : accès par l'icône horloge, saisie
 * sans date, compteur. Exécuté sur `pc` (panneau) et `iphone` (écran plein).
 */
test.describe('SD-01 — ajouter une tâche sans date dans « Un jour »', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('l’icône horloge ouvre « Un jour » ; « Retour » / « Fermer le panneau » le ferme (critères 1 et 2)', async ({ page }, testInfo) => {
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour');
    await openSomeday(page, testInfo);
    if (isPhone(testInfo)) await expect(page.getByText('Aucune tâche sans date')).toBeVisible();
    await closeSomeday(page, testInfo);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('Entrée crée la tâche sans date, vide le champ ; le badge compte, la tâche reste hors d’Aujourd’hui (critères 3, 6, 7)', async ({ page }, testInfo) => {
    await openSomeday(page, testInfo);
    await addToSomeday(page, 'Renouveler le passeport');
    await expect(page.getByRole('textbox', { name: 'Nouvelle tâche sans date' })).toBeFocused();
    await addToSomeday(page, 'Lire le rapport annuel');
    // En tête de liste : la plus récente d'abord (SD-04 critère 2).
    expect(await somedayTitles(page)).toEqual(['Lire le rapport annuel', 'Renouveler le passeport']);
    if (isPhone(testInfo)) await expect(page.getByText('2 tâches sans date, à planifier plus tard')).toBeVisible();

    await closeSomeday(page, testInfo);
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 2 tâches');
    await expect(page.getByRole('button', { name: 'Renouveler le passeport', exact: true })).toHaveCount(0);

    // Elles n'apparaissent pas non plus dans la Semaine.
    await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
    await expect(page.locator('.ct-week-day')).toHaveCount(7);
    await expect(page.getByRole('button', { name: 'Renouveler le passeport', exact: true })).toHaveCount(0);
  });

  test('un titre vide ne crée rien (critère 4)', async ({ page }, testInfo) => {
    await openSomeday(page, testInfo);
    if (!isPhone(testInfo)) await page.getByRole('button', { name: '+ Ajouter à « Un jour »' }).click();
    const field = page.getByRole('textbox', { name: 'Nouvelle tâche sans date' });
    await field.fill('   ');
    await field.press('Enter');
    await expect(somedayList(page)).toHaveCount(0);
  });

  test('cocher une ligne termine la tâche : elle quitte la liste et le compteur baisse (critère 8)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Renouveler le passeport' }, { title: 'Lire le rapport annuel', space: 'perso' }]);
    // La base du navigateur de développement est en mémoire : pas de rechargement ; Aujourd'hui relit la liste en se remontant.
    await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
    await todayTab(page).click();
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 2 tâches');
    await openSomeday(page, testInfo);
    await expect(somedayList(page).getByText('Pro', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Terminer : Renouveler le passeport' }).click();
    await expect(somedayList(page).getByRole('button', { name: 'Renouveler le passeport' })).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('« Renouveler le passeport » terminée');
    await closeSomeday(page, testInfo);
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
  });

  test('le compteur et la liste suivent le filtre d’espace global (critère 6)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Tâche Pro' }, { title: 'Tâche Perso', space: 'perso' }]);
    // La base du navigateur de développement est en mémoire : pas de rechargement ; Aujourd'hui relit la liste en se remontant.
    await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
    await todayTab(page).click();
    await openSomeday(page, testInfo);
    await filterPill(page, 'Perso').click();
    await expect.poll(() => somedayTitles(page)).toEqual(['Tâche Perso']);
    await closeSomeday(page, testInfo);
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 1 tâche');
  });

  test('iPhone : le bouton « + » ouvre la feuille avec « Un jour » présélectionné (critère 5)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Le bouton « + » de l’écran Un jour est propre à l’iPhone (PC : champ du panneau).');
    await openSomeday(page, testInfo);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await expect(dialog.getByRole('button', { name: 'Un jour' })).toHaveAttribute('aria-pressed', 'true');
    await dialog.getByLabel('Titre').fill('Sans date depuis la feuille');
    await dialog.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(dialog).toBeHidden();
    await expect(somedayList(page).getByRole('button', { name: 'Sans date depuis la feuille' })).toBeVisible();
  });
});
