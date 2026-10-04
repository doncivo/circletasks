import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { addEventButton, eventRow, insertEvents, openEvents, reopenEvents } from './helpers/events';
import { addIsoDays, browserToday } from './helpers/schedule';
import { dayOf, openWeek } from './helpers/week';

/**
 * E-04 — Je vois un compte à rebours.
 *
 * Couverture : « J-12 » dans la liste Événements (lu « dans 12 jours »), « J-1 », « Aujourd'hui », rien après ; anniversaire ;
 * interrupteur « Compte à rebours » (bouton à état « Afficher le compte à rebours », activé d'office pour un anniversaire) ; tag de la
 * fiche ; bandeaux de la Semaine et d'Aujourd'hui réservés aux événements importants ; mise à jour au passage de minuit sans
 * relancer l'app. Exécuté sur `pc` et `iphone`.
 */
test.describe('E-04 — compte à rebours', () => {
  test('liste : J-12, J-1, Aujourd’hui, rien après ; lu « dans 12 jours » (critères 1, 2, 7)', async ({ page }) => {
    await openApp(page);
    const today = await browserToday(page);
    await insertEvents(page, [
      { title: 'Dans douze jours', date: addIsoDays(today, 12) },
      { title: 'Demain', date: addIsoDays(today, 1) },
      { title: 'Aujourd’hui même', date: today },
      { title: 'Hier', date: addIsoDays(today, -1) },
    ]);
    await reopenEvents(page);
    await expect(eventRow(page, 'Dans douze jours').locator('.ct-event-row__tag')).toContainText('J-12');
    await expect(eventRow(page, 'Dans douze jours').locator('.ct-event-row__tag')).toContainText('dans 12 jours');
    await expect(eventRow(page, 'Demain').locator('.ct-event-row__tag')).toContainText('J-1');
    await expect(eventRow(page, 'Aujourd’hui même').locator('.ct-event-row__tag')).toContainText('Aujourd’hui');
    await expect(eventRow(page, 'Hier').locator('.ct-event-row__tag')).toHaveCount(0);
  });

  test('interrupteur « Afficher le compte à rebours » : désactivé pour un événement, activé pour un anniversaire (critères 5, 7, D2)', async ({ page }, testInfo) => {
    await openApp(page);
    await openEvents(page);
    await addEventButton(page, testInfo).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvel événement' });
    const toggle = sheet.getByRole('button', { name: 'Afficher le compte à rebours' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(sheet.getByText(/^Compte à rebours/)).toBeVisible();
    await sheet.getByRole('radio', { name: 'Anniversaire' }).check();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByRole('radio', { name: 'Événement' }).check();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('fiche : « J-n » d’un événement important, rien sans compte à rebours (critère 1)', async ({ page }) => {
    await openApp(page);
    const today = await browserToday(page);
    await insertEvents(page, [
      { title: 'Échéance', date: addIsoDays(today, 5), important: true },
      { title: 'Simple', date: addIsoDays(today, 6) },
    ]);
    await reopenEvents(page);
    await eventRow(page, 'Échéance').click();
    const fiche = page.getByRole('dialog', { name: 'Modifier l’événement' }).or(page.getByRole('complementary', { name: 'Modifier l’événement' }));
    await expect(fiche).toContainText('J-5');
    await expect(fiche.getByRole('button', { name: 'Afficher le compte à rebours' })).toHaveAttribute('aria-pressed', 'true');
    await fiche.getByRole('button', { name: 'Fermer' }).click();
    await eventRow(page, 'Simple').click();
    await expect(fiche.getByRole('button', { name: 'Afficher le compte à rebours' })).toHaveAttribute('aria-pressed', 'false');
    await expect(fiche.locator('.ct-event-form__tag')).toHaveCount(0);
  });

  test('bandeaux de la Semaine et d’Aujourd’hui : seulement les événements importants (critères 4, 5)', async ({ page }) => {
    // Mer. 23 sept. 2026 : l'événement important du ven. 25 affiche « J-2 », celui du jour « Aujourd'hui ».
    await page.clock.setFixedTime(new Date('2026-09-23T10:00:00+02:00'));
    await openApp(page);
    await insertEvents(page, [
      { title: 'Anniversaire de Karim', date: '2026-09-25', important: true, kind: 'birthday', repeat: 'yearly', birthYear: 1992 },
      { title: 'Réunion ordinaire', date: '2026-09-25' },
      { title: 'Échéance du jour', date: '2026-09-23', important: true },
    ]);
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Semaine', exact: true }).click();
    await expect(page.locator('.ct-week-day')).toHaveCount(7);
    await expect(dayOf(page, '2026-09-25').locator('.ct-week-event').filter({ hasText: 'Anniversaire de Karim' })).toContainText('J-2');
    await expect(dayOf(page, '2026-09-25').locator('.ct-week-event').filter({ hasText: 'Réunion ordinaire' }).locator('.ct-week-event__tag')).toHaveCount(0);
    await expect(dayOf(page, '2026-09-23').locator('.ct-week-event').filter({ hasText: 'Échéance du jour' })).toContainText('Aujourd’hui');
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Tâches', exact: true }).click();
    const band = page.getByRole('list', { name: 'Événements du jour' }).locator('li').filter({ hasText: 'Échéance du jour' });
    await expect(band.locator('.ct-today-event__tag')).toContainText('Aujourd’hui');
  });

  test('passage de minuit : le tag se met à jour sans relancer l’app (critère 3)', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-23T23:59:00+02:00') });
    await openApp(page);
    await insertEvents(page, [{ title: 'Échéance', date: '2026-09-25' }]);
    await reopenEvents(page);
    await expect(eventRow(page, 'Échéance').locator('.ct-event-row__tag')).toContainText('J-2');
    await page.clock.fastForward('02:00');
    await expect(eventRow(page, 'Échéance').locator('.ct-event-row__tag')).toContainText('J-1');
  });

  test('changement d’heure : « J-2 » reste « J-2 » à la veille du passage à l’heure d’hiver (critère 3)', async ({ page }) => {
    // 24 oct. 2026 : la nuit du 25 compte 25 heures ; le 26 reste à deux jours.
    await page.clock.setFixedTime(new Date('2026-10-24T10:00:00+02:00'));
    await openApp(page);
    await insertEvents(page, [{ title: 'Lundi', date: '2026-10-26' }, { title: 'Dimanche', date: '2026-10-25' }]);
    await reopenEvents(page);
    await expect(eventRow(page, 'Lundi').locator('.ct-event-row__tag')).toContainText('J-2');
    await expect(eventRow(page, 'Dimanche').locator('.ct-event-row__tag')).toContainText('J-1');
    await openWeek(page);
  });
});
