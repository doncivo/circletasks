import { expect, test, type Page } from '@playwright/test';
import { openCalendarsScreen } from './helpers/calendars';
import { localDate, openRemindersScreen, useFakeReminders } from './helpers/reminders';
import { createTask, rowOf } from './helpers/today';

/**
 * K-06 — Je coche un rappel dans CircleTasks ou dans Rappels. Parcours complet avec le faux EventKit (`__ctRemindersFake`, développement
 * seulement) sur le projet `iphone` : importer, terminer ici, terminer dans le faux, modifier un titre des deux côtés, créer avec le réglage
 * activé, supprimer. Projet `pc` : les Rappels n'ont aucun plugin, le réglage de création n'est pas proposé (« Se règle sur l'iPhone »).
 * L'écriture vers Rappels part 6 s après l'écriture locale (annulation de 5 s, T-13) : les attentes sont des sondages bornés, jamais un délai.
 */
const IPHONE = { project: { name: 'iphone' } };
const SEND_BUDGET_MS = 20_000;

const section = (page: Page) => page.getByRole('region', { name: 'RAPPELS APPLE' });

test.describe('K-06 — Rappels Apple, écritures (iPhone)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone', 'iPhone seulement');
    await useFakeReminders(page);
  });

  test('parcours : importer, terminer ici puis dans Rappels, modifier un titre dans Rappels, supprimer avec « Supprimer aussi dans Rappels ? »', async ({ page }) => {
    const reminders = await openRemindersScreen(page);
    const today = await localDate(page);
    await reminders.addList('L-courses', 'Courses');
    const pain = await reminders.add({ listId: 'L-courses', title: 'Acheter du pain', due: { date: today, time: null } });
    const lait = await reminders.add({ listId: 'L-courses', title: 'Acheter du lait', due: { date: today, time: null } });
    const riz = await reminders.add({ listId: 'L-courses', title: 'Acheter du riz', due: { date: today, time: null } });
    await openCalendarsScreen(page);
    await section(page).getByRole('checkbox', { name: 'Afficher Courses' }).click();
    await expect(section(page).getByText(/^Mis à jour à/)).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(rowOf(page, 'Acheter du pain')).toContainText('Rappels');

    // Terminer ici : le rappel est terminé après le délai d'annulation ; rien n'est écrit avant.
    await page.getByRole('checkbox', { name: 'Terminer : Acheter du pain' }).click();
    expect(await reminders.writes()).toEqual([]);
    await expect.poll(async () => (await reminders.get(pain.id))?.completed, { timeout: SEND_BUDGET_MS }).toBe(true);
    expect((await reminders.writes()).map((write) => write.kind)).toEqual(['complete']);

    // Terminer dans Rappels : la tâche est terminée au passage suivant, sans écriture en retour.
    await reminders.edit(lait.id, { completed: true });
    await reminders.emitChanged();
    await expect(page.getByRole('checkbox', { name: 'Rouvrir : Acheter du lait' })).toBeVisible();
    expect((await reminders.writes()).map((write) => write.kind)).toEqual(['complete']);

    // Titre modifié dans Rappels : la tâche le suit au passage suivant (le conflit des deux côtés est couvert en Vitest).
    await reminders.edit(riz.id, { title: 'Acheter du riz basmati' });
    await reminders.emitChanged();
    await expect(rowOf(page, 'Acheter du riz basmati')).toBeVisible();

    // Supprimer : la confirmation nomme Rappels ; le rappel est supprimé après le délai d'annulation.
    await rowOf(page, 'Acheter du riz basmati').getByRole('button', { name: 'Acheter du riz basmati', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Détail de la tâche' });
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Supprimer la tâche' }).click();
    const confirmation = page.getByRole('alertdialog', { name: 'Supprimer aussi dans Rappels ?' });
    await expect(confirmation).toContainText('« Acheter du riz basmati » est liée à un rappel : il sera aussi supprimé dans Rappels.');
    await confirmation.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect.poll(async () => await reminders.get(riz.id), { timeout: SEND_BUDGET_MS }).toBeNull();
  });

  test('création : désactivée par défaut (aucune écriture), activée pour un espace avec sa liste : un rappel est créé dans cette liste', async ({ page }, testInfo) => {
    const reminders = await openRemindersScreen(page);
    await reminders.addList('L-courses', 'Courses');
    await openCalendarsScreen(page);
    await section(page).getByRole('checkbox', { name: 'Afficher Courses' }).click();
    await section(page).getByRole('combobox', { name: 'Espace de Courses' }).selectOption({ label: 'Perso' });
    // Désactivé par défaut : aucun appel d'écriture après une création.
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await createTask(page, IPHONE, { title: 'Tâche ordinaire' });
    expect(await reminders.writes()).toEqual([]);
    // Activation : refusée sans liste affichée de l'espace Pro, acceptée pour Perso.
    await openCalendarsScreen(page);
    await section(page).getByRole('switch', { name: 'Créer aussi dans Rappels · Pro' }).click();
    await expect(section(page).getByText('Affichez d’abord une liste de cet espace.')).toBeVisible();
    await section(page).getByRole('switch', { name: 'Créer aussi dans Rappels · Perso' }).click();
    await expect(section(page).getByRole('switch', { name: 'Créer aussi dans Rappels · Perso' })).toHaveAttribute('aria-checked', 'true');
    // Une tâche Perso (espace choisi par le filtre) crée un rappel ; la tâche existante n'est jamais envoyée.
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    await createTask(page, IPHONE, { title: 'Acheter des œufs' });
    await expect.poll(async () => (await reminders.all()).map((item) => item.title), { timeout: SEND_BUDGET_MS }).toEqual(['Acheter des œufs']);
    expect((await reminders.all())[0]?.listId).toBe('L-courses');
    expect((await reminders.writes()).map((write) => write.kind)).toEqual(['create']);
    void testInfo;
  });

  test('échec d’écriture : le nombre de modifications en attente est affiché et le bandeau le dit ; effacé quand tout est parti', async ({ page }) => {
    const reminders = await openRemindersScreen(page);
    const today = await localDate(page);
    await reminders.addList('L-courses', 'Courses');
    const item = await reminders.add({ listId: 'L-courses', title: 'Fragile', due: { date: today, time: null } });
    await openCalendarsScreen(page);
    await section(page).getByRole('checkbox', { name: 'Afficher Courses' }).click();
    await expect(section(page).getByText(/^Mis à jour à/)).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await reminders.failNext('setCompleted', 'store-unavailable');
    await page.getByRole('checkbox', { name: 'Terminer : Fragile' }).click();
    const banner = page.locator('.ct-status-banner').filter({ hasText: '1 modification(s) n’ont pas pu être envoyées vers Rappels' });
    await expect(banner).toBeVisible({ timeout: SEND_BUDGET_MS });
    // Réessai à chaque passage (reprise) : tout part, le bandeau disparaît.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(async () => (await reminders.get(item.id))?.completed, { timeout: SEND_BUDGET_MS }).toBe(true);
    await expect(banner).toHaveCount(0);
  });
});

test.describe('K-06 — projet pc', () => {
  test('le réglage de création n’est pas proposé : « Se règle sur l’iPhone »', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'PC seulement');
    await page.goto('/');
    await expect(page.getByRole('navigation')).toBeVisible();
    await openCalendarsScreen(page);
    await expect(section(page).getByText('Se règle sur l’iPhone')).toBeVisible();
    await expect(section(page).getByRole('switch')).toHaveCount(0);
    await expect(section(page).getByText('CRÉER AUSSI DANS RAPPELS')).toHaveCount(0);
  });
});
