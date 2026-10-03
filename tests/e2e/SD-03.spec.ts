import { expect, test } from '@playwright/test';
import { closeSomeday, insertSomeday, openSomeday, somedayButton, somedayTitles } from './helpers/someday';
import { detailOf } from './helpers/spaces';
import { browserToday } from './helpers/schedule';
import { createTask, isPhone, openToday, rowOf } from './helpers/today';
import { insertTasks, openWeek, taskButton, dayOf } from './helpers/week';

/**
 * SD-03 — Je renvoie une tâche datée vers « Un jour ». Parcours clé 12 (renvoi) : bouton « Un jour » de la fiche depuis Aujourd'hui et
 * la Semaine, message « Annuler », tâche récurrente grisée (QB-11). Exécuté sur `pc` et `iphone`.
 */
test.describe('SD-03 — renvoyer une tâche datée vers « Un jour »', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('depuis Aujourd’hui : la tâche quitte la liste, entre en tête de « Un jour », le badge monte, Annuler la rend (critères 1 et 3)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Ancienne tâche' }]);
    await createTask(page, testInfo, { title: 'Appeler le notaire', time: '14:00' });
    await rowOf(page, 'Appeler le notaire').getByRole('button', { name: 'Appeler le notaire', exact: true }).click();
    await detailOf(page).getByRole('button', { name: 'Un jour' }).click();

    const status = page.getByRole('status');
    await expect(status).toContainText('« Appeler le notaire » mise dans « Un jour »');
    await expect(rowOf(page, 'Appeler le notaire')).toHaveCount(0);

    await status.getByRole('button', { name: 'Annuler' }).click();
    await expect(rowOf(page, 'Appeler le notaire')).toContainText('14:00');
  });

  test('en tête de la liste « Un jour », badge incrémenté (critère 1)', async ({ page }, testInfo) => {
    await insertSomeday(page, [{ title: 'Ancienne tâche' }]);
    await createTask(page, testInfo, { title: 'Appeler le notaire', time: '14:00' });
    await rowOf(page, 'Appeler le notaire').getByRole('button', { name: 'Appeler le notaire', exact: true }).click();
    await detailOf(page).getByRole('button', { name: 'Un jour' }).click();
    await expect(page.getByRole('status')).toContainText('mise dans « Un jour »');
    // iPhone : la fiche est une feuille plein écran, à fermer avant d'ouvrir « Un jour ».
    if (isPhone(testInfo)) await detailOf(page).getByRole('button', { name: 'Fermer' }).first().click();
    await openSomeday(page, testInfo);
    await expect.poll(() => somedayTitles(page)).toEqual(['Appeler le notaire', 'Ancienne tâche']);
    await closeSomeday(page, testInfo);
    await expect(somedayButton(page)).toHaveAccessibleName('Un jour, 2 tâches');
  });

  test('depuis la Semaine : même effet, la carte quitte la colonne (critère 1)', async ({ page }) => {
    const today = await browserToday(page);
    await insertTasks(page, [{ title: 'Préparer la réunion', date: today, space: 'perso' }]);
    await openWeek(page);
    await expect(dayOf(page, today)).toContainText('Préparer la réunion');
    await taskButton(page, 'Préparer la réunion').click();
    await detailOf(page).getByRole('button', { name: 'Un jour' }).click();
    await expect(page.getByRole('status')).toContainText('« Préparer la réunion » mise dans « Un jour »');
    await expect(dayOf(page, today)).not.toContainText('Préparer la réunion');
  });

  test('tâche récurrente : « Un jour » grisé avec l’aide « Arrêtez d’abord la répétition », rien ne change (QB-11, critère 6)', async ({ page }) => {
    const today = await browserToday(page);
    await insertTasks(page, [{ title: 'Faire les comptes', date: today, daily: true }]);
    await openWeek(page);
    await taskButton(page, 'Faire les comptes').click();
    const button = detailOf(page).getByRole('button', { name: 'Un jour' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription('Arrêtez d’abord la répétition');
    await button.click({ force: true });
    await expect(page.getByRole('status')).toHaveCount(0);
    await expect(dayOf(page, today)).toContainText('Faire les comptes');
  });
});
