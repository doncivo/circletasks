import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, openRoutines, routineForm, setRoutineTime } from './helpers/routines';
import { setWheels } from './helpers/schedule';
import { isPhone } from './helpers/today';

/**
 * N-FIX-04 — Rappel dans la plage silencieuse : l'app le dit au moment du choix, et la routine le montre.
 *
 * Plages Pro par défaut : chaque soir 19:00 → 08:00 et le week-end. Une routine Pro à 20:00 sonne au prochain matin de semaine à 08:00 :
 * la ligne de la routine le dit (« Rappels décalés à 08:00 »), le formulaire le dit dès le choix de l'heure, avec la cause de l'heure
 * choisie (« après 19:00 », ou « le week-end » si le jour courant est un samedi ou un dimanche). Exécuté sur `pc` et `iphone`.
 */
const NOTICE = /^Rappel décalé (au [a-zé]+ |à )08:00 — aucun rappel Pro (après 19:00|le week-end)$/;

test.describe('N-FIX-04 — rappel dans la plage silencieuse', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('ligne de la routine : tous décalés, partiel (week-end), aucun (Perso)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Yoga du soir', space: 'pro', time: '20:00', reminders: [0] },
      { title: 'Lecture', space: 'pro', time: '10:00', reminders: [0] },
      { title: 'Marche', space: 'perso', time: '20:00', reminders: [0] },
    ]);
    await openRoutines(page);
    await expect(cardOf(page, 'Yoga du soir')).toContainText('Rappels décalés à 08:00');
    await expect(cardOf(page, 'Lecture')).toContainText('Rappels du week-end décalés au lundi 08:00');
    await expect(cardOf(page, 'Marche')).not.toContainText('décalé');
  });

  test('formulaire de modification d’une routine : la ligne apparaît à 20:00 et disparaît à 10:00', async ({ page }, testInfo) => {
    await insertRoutines(page, [{ title: 'Yoga du soir', space: 'pro', time: '20:00', reminders: [0] }]);
    await openRoutines(page);
    await cardOf(page, 'Yoga du soir').getByRole('button', { name: /Modifier la routine/ }).click();
    const form = routineForm(page, 'Modifier la routine');
    await expect(form.getByRole('status')).toHaveText(NOTICE);
    await setRoutineTime(page, form, testInfo, '10:00');
    await expect(form.getByRole('status')).toHaveCount(0);
  });

  test('nouvelle tâche iPhone : Pro, 20:00, « À l’heure » : la ligne est dans le bloc Rappel avant même d’enregistrer', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'feuille iPhone seulement ; le PC est couvert par la fiche en Vitest');
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
    await dialog.getByLabel('Titre').fill('Relire le contrat');
    await setWheels(page, dialog, { time: '20:00' });
    await dialog.getByRole('button', { name: /Plus d.options/ }).click();
    await expect(dialog.getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('status')).toHaveText(NOTICE);
  });
});
