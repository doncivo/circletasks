import { expect, test, type Page } from '@playwright/test';
import { openCalendarsScreen } from './helpers/calendars';
import { localDate, openRemindersScreen, useFakeReminders } from './helpers/reminders';
import { rowOf } from './helpers/today';

/**
 * K-05 — Je vois mes Rappels Apple dans CircleTasks. Projet `iphone` : faux EventKit (`__ctRemindersFake`, développement seulement), aucun
 * compte réel. Critères couverts : 7, 8, 9, 12, 13. Sur `pc`, la section est en lecture seule (voir K-07).
 */
test.describe('K-05 — Rappels Apple (iPhone)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'iPhone seulement');
    await useFakeReminders(page);
  });

  const section = (page: Page) => page.getByRole('region', { name: 'RAPPELS APPLE' });

  test('listes Courses et Travail avec « Afficher » et l’espace (prérempli Pro) ; la ligne de Réglages devient « 2 listes » ; les rappels deviennent des tâches avec le badge Rappels (critères 8, 9 et 13)', async ({ page }) => {
    const reminders = await openRemindersScreen(page);
    const today = await localDate(page);
    await reminders.addList('L-courses', 'Courses');
    await reminders.addList('L-travail', 'Travail');
    await reminders.add({ listId: 'L-travail', title: 'Appeler le notaire', due: { date: today, time: '10:00' } });
    await reminders.add({ listId: 'L-courses', title: 'Idée de cadeau' });
    await openCalendarsScreen(page);
    await expect(section(page).getByRole('checkbox', { name: 'Afficher Courses' })).toHaveAttribute('aria-checked', 'false');
    await expect(section(page).getByRole('checkbox', { name: 'Afficher Travail' })).toBeVisible();
    await section(page).getByRole('checkbox', { name: 'Afficher Travail' }).click();
    await expect(section(page).getByRole('combobox', { name: 'Espace de Travail' })).toHaveValue('00000000-0000-4000-8000-000000000001');
    await section(page).getByRole('checkbox', { name: 'Afficher Courses' }).click();
    await expect(section(page).getByText(/^Mis à jour à \d{2}:\d{2}$/)).toBeVisible();
    await page.getByRole('button', { name: 'Retour aux réglages' }).click();
    await expect(page.getByRole('button', { name: 'Agendas · Rappels Apple : 2 listes' })).toBeVisible();

    // Les rappels sont devenus des tâches : date du jour à 10:00 avec le badge ; sans échéance dans « Un jour ».
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    const row = rowOf(page, 'Appeler le notaire');
    await expect(row).toContainText('10:00');
    await expect(row).toContainText('Rappels');
    expect(await reminders.writes()).toEqual([]);
  });

  test('accès non décidé : explication puis « Autoriser l’accès aux Rappels » ; refusé : état persistant et bandeau, aucune liste lue ; rétabli : tout disparaît (critère 7)', async ({ page }) => {
    const reminders = await openRemindersScreen(page);
    await reminders.addList('L-courses', 'Courses');
    await reminders.setAccess('not-determined');
    await openCalendarsScreen(page);
    await expect(section(page).getByText(/Rien n’est lu avant que vous autorisiez l’accès/)).toBeVisible();
    await expect(section(page).getByRole('checkbox')).toHaveCount(0);
    await section(page).getByRole('button', { name: 'Autoriser l’accès aux Rappels' }).click();
    await expect(section(page).getByRole('checkbox', { name: 'Afficher Courses' })).toBeVisible();
    // Accès retiré dans les réglages d'iOS : à l'actualisation, l'état est persistant et le bandeau apparaît.
    await reminders.setAccess('denied');
    await section(page).getByRole('button', { name: 'Actualiser les Rappels' }).click();
    await expect(page.locator('.ct-status-banner').filter({ hasText: 'L’accès aux Rappels est refusé' })).toBeVisible();
    await expect(section(page).getByText('L’accès aux Rappels est refusé. Autorisez-le dans Réglages d’iOS, Confidentialité et sécurité, Rappels.')).toBeVisible();
    // Rétabli dans les réglages d'iOS : à la reprise (actualisation), l'état et le bandeau disparaissent.
    await reminders.setAccess('full');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('.ct-status-banner').filter({ hasText: 'L’accès aux Rappels est refusé' })).toHaveCount(0);
    await expect(section(page).getByRole('checkbox', { name: 'Afficher Courses' })).toBeVisible();
  });

  test('échec du magasin : le code est affiché et le bandeau « Les Rappels Apple n’ont pas pu être lus » aussi ; effacés au premier passage réussi (critère 12)', async ({ page }) => {
    const reminders = await openRemindersScreen(page);
    await reminders.addList('L-courses', 'Courses');
    await openCalendarsScreen(page);
    await section(page).getByRole('checkbox', { name: 'Afficher Courses' }).click();
    await expect(section(page).getByText(/^Mis à jour à/)).toBeVisible();
    await reminders.failNext('lists', 'store-unavailable');
    await section(page).getByRole('button', { name: 'Actualiser les Rappels' }).click();
    await expect(section(page).getByText('Les Rappels Apple n’ont pas pu être lus (store-unavailable).')).toBeVisible();
    await expect(page.locator('.ct-status-banner').filter({ hasText: 'Les Rappels Apple n’ont pas pu être lus' })).toBeVisible();
    await section(page).getByRole('button', { name: 'Actualiser les Rappels' }).click();
    await expect(section(page).getByText(/store-unavailable/)).toHaveCount(0);
    await expect(page.locator('.ct-status-banner').filter({ hasText: 'Les Rappels Apple n’ont pas pu être lus' })).toHaveCount(0);
  });
});
