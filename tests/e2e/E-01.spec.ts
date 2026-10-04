import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { addEventButton, disableHolidays, eventRow, insertEvents, openEvents, reopenEvents } from './helpers/events';
import { addIsoDays, browserToday } from './helpers/schedule';
import { isPhone } from './helpers/today';
import { dayOf, openWeek } from './helpers/week';

/**
 * E-01 — Je crée un événement daté, avec ou sans heure.
 *
 * Couverture : liste de l'année (← 2026 →, passé grisé, « Aujourd'hui », état vide, filtre d'espace) ; feuille « Nouvel événement »
 * (segments Tâche / Événement / Routine, titre conservé, journée entière ou plage horaire, répétition, rappels, espace) ; l'événement
 * apparaît dans la liste, Aujourd'hui et la Semaine ; modification de la série et suppression annulable ; PC : grille du mois et carte
 * des agendas ; iPhone : « Calendrier » ; « + » d'Aujourd'hui (segment Tâche) et de Routines (segment Routine). Exécuté sur `pc` et `iphone`.
 */
test.describe('E-01 — événements datés', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    // Les listes et la grille de ces tests ne portent que leurs propres événements (les fériés sont couverts par E-03).
    await disableHolidays(page);
  });

  test('état vide « Aucun événement en {année} » et flèches d’année (critère 1)', async ({ page }) => {
    const year = Number((await browserToday(page)).slice(0, 4));
    await openEvents(page);
    await expect(page.getByText(`Aucun événement en ${year}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Année suivante' }).click();
    await expect(page.getByText(`Aucun événement en ${year + 1}`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Année précédente' }).click();
    await page.getByRole('button', { name: 'Année précédente' }).click();
    await expect(page.getByText(`Aucun événement en ${year - 1}`, { exact: true })).toBeVisible();
  });

  test('liste par mois : passé grisé, « Aujourd’hui », série mensuelle, filtre d’espace (critères 1, 4, 10)', async ({ page }) => {
    const today = await browserToday(page);
    await insertEvents(page, [
      { title: 'Hier', date: addIsoDays(today, -1) },
      { title: 'Point client', date: today, start: '10:00', end: '11:00' },
      { title: 'Comité', date: addIsoDays(today, 3), repeat: 'monthly', space: 'perso' },
    ]);
    await reopenEvents(page);
    await expect(eventRow(page, 'Hier')).toHaveAttribute('data-past', 'true');
    await expect(eventRow(page, 'Point client')).not.toHaveAttribute('data-past', 'true');
    await expect(eventRow(page, 'Point client')).toContainText('Aujourd’hui');
    await expect(eventRow(page, 'Point client')).toContainText('10:00 – 11:00');
    await expect(eventRow(page, 'Comité').first()).toContainText('Mensuel');
    await page.getByRole('button', { name: 'Pro', exact: true }).first().click();
    await expect(eventRow(page, 'Comité')).toHaveCount(0);
    await expect(eventRow(page, 'Point client')).toBeVisible();
    await page.getByRole('button', { name: 'Perso', exact: true }).first().click();
    await expect(eventRow(page, 'Point client')).toHaveCount(0);
    await expect(eventRow(page, 'Comité').first()).toBeVisible();
  });

  test('« + » ouvre « Nouvel événement » ; le titre suit les segments ; journée entière enregistrée (critères 2, 5, 6)', async ({ page }, testInfo) => {
    const today = await browserToday(page);
    await openEvents(page);
    await addEventButton(page, testInfo).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvel événement' });
    await expect(sheet.getByRole('button', { name: 'Événement', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await sheet.getByLabel('Titre', { exact: true }).fill('Dîner de famille');
    await sheet.getByRole('button', { name: 'Tâche', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByLabel('Titre', { exact: true })).toHaveValue('Dîner de famille');
    await page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByRole('button', { name: 'Routine', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Nouvelle routine' }).getByLabel('Nom de la routine')).toHaveValue('Dîner de famille');
    await page.getByRole('dialog', { name: 'Nouvelle routine' }).getByRole('button', { name: 'Événement', exact: true }).click();
    const back = page.getByRole('dialog', { name: 'Nouvel événement' });
    await expect(back.getByLabel('Titre', { exact: true })).toHaveValue('Dîner de famille');
    await expect(back.getByRole('checkbox', { name: /Journée entière/ })).toBeChecked();
    await back.getByRole('radio', { name: 'Annuel' }).check();
    await back.getByRole('checkbox', { name: 'La veille' }).check();
    await back.getByRole('button', { name: 'Perso', exact: true }).click();
    await back.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(back).toBeHidden();
    await expect(eventRow(page, 'Dîner de famille')).toContainText('Annuel');
    await expect(eventRow(page, 'Dîner de famille')).toContainText('Aujourd’hui');

    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Événements du jour' }).getByText('Dîner de famille')).toBeVisible();
    await openWeek(page);
    await expect(dayOf(page, today).getByText('Dîner de famille')).toBeVisible();
  });

  test('plage horaire : Début et Fin, durée d’une heure par défaut (critère 3)', async ({ page }, testInfo) => {
    await openEvents(page);
    await addEventButton(page, testInfo).click();
    const sheet = page.getByRole('dialog', { name: 'Nouvel événement' });
    await sheet.getByLabel('Titre', { exact: true }).fill('Atelier');
    await sheet.getByRole('checkbox', { name: /Journée entière/ }).uncheck();
    await expect(sheet.getByText('Début', { exact: true })).toBeVisible();
    await expect(sheet.getByText('Fin', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(sheet).toBeHidden();
    await expect(eventRow(page, 'Atelier')).toContainText('09:00 – 10:00');
  });

  test('modifier la série puis supprimer avec « Annuler » (critère 7)', async ({ page }) => {
    const today = await browserToday(page);
    await insertEvents(page, [{ title: 'Comité', date: addIsoDays(today, 2), repeat: 'monthly' }]);
    await reopenEvents(page);
    await eventRow(page, 'Comité').first().click();
    const edit = page.getByRole('dialog', { name: 'Modifier l’événement' }).or(page.getByRole('complementary', { name: 'Modifier l’événement' }));
    await expect(edit.getByRole('radio', { name: 'Mensuel' })).toBeChecked();
    await edit.getByLabel('Titre', { exact: true }).fill('Comité stratégique');
    await edit.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(eventRow(page, 'Comité stratégique').first()).toBeVisible();
    await expect(eventRow(page, 'Comité')).toHaveCount(0);

    await eventRow(page, 'Comité stratégique').first().click();
    await edit.getByRole('button', { name: 'Supprimer l’événement' }).click();
    await page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /Supprimer/ })).getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(eventRow(page, 'Comité stratégique')).toHaveCount(0);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(eventRow(page, 'Comité stratégique').first()).toBeVisible();
  });

  test('grille du mois : PC volet droit avec points et carte des agendas ; iPhone « Calendrier » (critères 8, 9)', async ({ page }, testInfo) => {
    const today = await browserToday(page);
    await insertEvents(page, [{ title: 'Réunion', date: today }, { title: 'Dîner', date: today, space: 'perso' }]);
    await reopenEvents(page);
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Calendrier', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Calendrier' });
      await expect(sheet.getByTestId('event-dot')).toHaveCount(2);
      await sheet.getByRole('button', { name: /avec des événements/ }).click();
      await expect(sheet).toBeHidden();
      return;
    }
    const aside = page.getByRole('complementary', { name: 'Calendrier' });
    await expect(aside.getByTestId('event-dot')).toHaveCount(2);
    await expect(aside.getByText('Aucun agenda connecté')).toBeVisible();
    await expect(aside.getByRole('button', { name: 'Réglages' })).toBeVisible();
    await aside.getByRole('button', { name: /avec des événements/ }).click();
    await expect(eventRow(page, 'Réunion')).toBeVisible();
  });

  test('« + » d’Aujourd’hui (iPhone) et de la Semaine ouvre le segment Tâche, « + » de Routines le segment Routine (critère 2)', async ({ page }, testInfo) => {
    // PC : le « + » d'Aujourd'hui place le focus dans le champ d'ajout rapide (A-01) ; la feuille s'ouvre depuis la Semaine.
    if (!isPhone(testInfo)) await openWeek(page);
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const task = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await expect(task.getByRole('button', { name: 'Tâche', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await task.getByRole('button', { name: 'Fermer' }).click();
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: /^Ajouter|Nouvelle routine/ }).first().click();
    const routine = page.getByRole('dialog', { name: 'Nouvelle routine' });
    await expect(routine.getByRole('button', { name: 'Routine', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });
});
