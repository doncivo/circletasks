import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, reopenRoutines, routineForm } from './helpers/routines';
import { addIsoDays } from './helpers/schedule';

/**
 * R-04 — Je suis ma série.
 *
 * Date figée au mer. 23 sept. 2026. Couverture : série sur la carte (« série 10 jours », seulement si > 0), qui passe à 11 quand on
 * valide aujourd'hui ; Sport lun., mer., ven. (séances, jours non prévus sans effet) ; occurrence manquée = série à 0 ; unités
 * jours / séances / semaines et accords ; « X fois par semaine » en semaines consécutives (QB-02) ; encart « Série en cours · Meilleure »
 * du formulaire de modification. Exécuté sur `pc` et `iphone`.
 */
function days(from: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addIsoDays(from, i));
}

test.describe('R-04 — série en cours et meilleure série', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
  });

  test('quotidienne : 10 jours validés, aujourd’hui non fait = « série 10 jours » ; après validation d’aujourd’hui : 11 (critère 1)', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Faire mon lit', space: 'perso', time: '07:30', done: days('2026-09-13', 10) }]);
    await reopenRoutines(page);
    const card = cardOf(page, 'Faire mon lit');
    await expect(card).toContainText('07:30 · Perso · série 10 jours');
    await card.getByRole('checkbox', { name: 'Mercredi', exact: true }).click();
    await expect(card).toContainText('série 11 jours');
  });

  test('Sport lun., mer., ven. : 4 séances, mardi et jeudi ne cassent pas ; mercredi non validé : toujours 4 ; plus tard : 0 (critères 2, 3)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], done: ['2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21'] },
      { title: 'Yoga', scheduleType: 'weekdays', weekdays: [1, 3, 5], done: ['2026-09-14', '2026-09-16'] },
    ]);
    await reopenRoutines(page);
    // Aujourd'hui mer. 23 (prévu, non validé) ne casse pas la série de Sport : 4 séances.
    await expect(cardOf(page, 'Sport')).toContainText('lun., mer., ven. · série 4 séances');
    // Yoga : ven. 18 prévu et manqué -> 0, aucune mention.
    await expect(cardOf(page, 'Yoga')).not.toContainText('série');
  });

  test('singulier et pluriel : « série 1 jour », « série 1 séance » (critère 6)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Un jour', done: ['2026-09-22'] },
      { title: 'Une séance', scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-17', done: ['2026-09-20'] },
    ]);
    await reopenRoutines(page);
    await expect(cardOf(page, 'Un jour')).toContainText('série 1 jour');
    await expect(cardOf(page, 'Un jour')).not.toContainText('série 1 jours');
    await expect(cardOf(page, 'Une séance')).toContainText('série 1 séance');
  });

  test('« 3 fois par semaine » : « série 4 semaines » ; la semaine en cours incomplète ne la casse pas (critère 9, QB-02)', async ({ page }) => {
    const weeks = ['2026-08-31', '2026-09-07', '2026-09-14'].flatMap((monday) => days(monday, 3));
    await insertRoutines(page, [
      { title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 3, startDate: '2026-08-01', done: [...weeks, '2026-09-21', '2026-09-22', '2026-09-23'] },
      { title: 'Nager', scheduleType: 'x_per_week', timesPerWeek: 3, startDate: '2026-08-01', done: [...weeks, '2026-09-21'] },
      { title: 'Marcher', scheduleType: 'x_per_week', timesPerWeek: 3, startDate: '2026-08-01', done: [...days('2026-09-14', 3), ...days('2026-09-07', 2)] },
    ]);
    await reopenRoutines(page);
    // Courir : 3 semaines complètes + la semaine en cours atteinte = 4 semaines.
    await expect(cardOf(page, 'Courir')).toContainText('3 fois par semaine · série 4 semaines');
    // Nager : 3 semaines complètes + la semaine en cours à 1/3 (ne casse pas) = 3 semaines.
    await expect(cardOf(page, 'Nager')).toContainText('série 3 semaines');
    // Marcher : semaine du 14 complète, celle du 7 à 2/3 : 1 semaine, la semaine du 21 sans validation (passée... en cours) ne casse pas.
    await expect(cardOf(page, 'Marcher')).not.toContainText('série 2 semaines');
  });

  test('le formulaire de modification affiche « Série en cours » et « Meilleure » (critère 7)', async ({ page }) => {
    const best = ['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-13', '2026-07-15', '2026-07-17', '2026-07-20', '2026-07-22', '2026-07-24', '2026-07-27', '2026-07-29'];
    await insertRoutines(page, [
      { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: '2026-06-01', done: [...best, '2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21'] },
    ]);
    await reopenRoutines(page);
    await cardOf(page, 'Sport').getByRole('button', { name: 'Éditer la routine Sport' }).click();
    const form = routineForm(page, 'Modifier la routine');
    await expect(form).toContainText('Série en cours 4 séances');
    await expect(form.getByLabel('Meilleure série 11 séances')).toContainText('Meilleure 11');
  });
});
