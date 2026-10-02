import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, insertRoutines, openRoutines, reopenRoutines, routineForm } from './helpers/routines';
import { isPhone, todayTab } from './helpers/today';

/**
 * R-07 — Je planifie une routine tous les N jours ou toutes les N semaines.
 *
 * Date figée au mer. 23 sept. 2026 (maquette ModifierRoutine-N.html). Couverture : bornes de N (2-30 jours, 2-8 semaines), bascule
 * jours / semaines, date de départ choisie, aperçu « Prochaines fois », ronds L à D préréglés en mode semaines (QB-04), carte,
 * apparition dans Aujourd'hui aux seules dates prévues. Exécuté sur `pc` et `iphone`.
 */
test.describe('R-07 — tous les N jours / semaines', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await openApp(page);
    await openRoutines(page);
  });

  async function openEveryN(page: Page, testInfo: { project: { name: string } }, title: string) {
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
    const form = routineForm(page, 'Nouvelle routine');
    await form.getByLabel('Nom de la routine').fill(title);
    await form.getByLabel('Fréquence', { exact: true }).selectOption('every_n');
    return form;
  }

  test('N par défaut 2, bornes jours / semaines (critère 1)', async ({ page }, testInfo) => {
    const form = await openEveryN(page, testInfo, 'Séance d’étirements');
    const group = form.getByRole('group', { name: 'Fréquence : tous les N' });
    await expect(group.getByTestId('interval-value')).toHaveText('2');
    await expect(group.getByRole('button', { name: 'Diminuer' })).toBeDisabled();
    for (let i = 0; i < 30; i += 1) await group.getByRole('button', { name: 'Augmenter' }).click({ force: true });
    await expect(group.getByTestId('interval-value')).toHaveText('30');
    await expect(group.getByRole('button', { name: 'Augmenter' })).toBeDisabled();
    await group.getByRole('button', { name: 'semaines', exact: true }).click();
    await expect(group.getByTestId('interval-value')).toHaveText('8');
    await expect(group.getByRole('button', { name: 'Augmenter' })).toBeDisabled();
  });

  test('aperçu des prochaines fois depuis aujourd’hui, départ par défaut = aujourd’hui (critères 2, 3)', async ({ page }, testInfo) => {
    const form = await openEveryN(page, testInfo, 'Séance d’étirements');
    const group = form.getByRole('group', { name: 'Fréquence : tous les N' });
    await group.getByRole('button', { name: 'Augmenter' }).click(); // N = 3
    // Départ = mer. 23 sept. : 23, 26, 29 sept., 2 oct.
    await expect(form.getByText('Prochaines fois : mer. 23, sam. 26, mar. 29 sept., ven. 2 oct.')).toBeVisible();
    if (isPhone(testInfo)) await expect(form.getByRole('button', { name: 'Mer. 23 sept.' })).toBeVisible();
    else await expect(form.getByRole('combobox', { name: 'Date de départ' })).toBeVisible();
  });

  test('PC : une date de départ passée (lun. 21 sept.) donne jeu. 24, dim. 27, mer. 30 sept., sam. 3 oct. (critère 3)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'saisie au clavier du champ de date : PC ; les roues iPhone sont couvertes en Testing Library');
    const form = await openEveryN(page, testInfo, 'Séance d’étirements');
    await form.getByRole('group', { name: 'Fréquence : tous les N' }).getByRole('button', { name: 'Augmenter' }).click();
    const field = form.getByRole('combobox', { name: 'Date de départ' });
    await field.fill('21/09/2026');
    await field.press('Enter');
    await expect(form.getByText('Prochaines fois : jeu. 24, dim. 27, mer. 30 sept., sam. 3 oct.')).toBeVisible();
  });

  test('iPhone : la date de départ se règle avec les roues', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'roues : iPhone');
    const form = await openEveryN(page, testInfo, 'Séance d’étirements');
    await form.getByRole('group', { name: 'Fréquence : tous les N' }).getByRole('button', { name: 'Augmenter' }).click();
    await form.getByRole('button', { name: 'Mer. 23 sept.' }).click();
    const day = form.getByRole('spinbutton', { name: 'Jour' });
    await day.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(form.getByRole('button', { name: 'Lun. 21 sept.' })).toBeVisible();
    await expect(form.getByText('Prochaines fois : jeu. 24, dim. 27, mer. 30 sept., sam. 3 oct.')).toBeVisible();
  });

  test('toutes les 2 semaines : ronds préréglés sur le jour de départ, plusieurs jours possibles, grisé sans jour (critère 5, QB-04)', async ({ page }, testInfo) => {
    const form = await openEveryN(page, testInfo, 'Courses');
    await form.getByRole('group', { name: 'Fréquence : tous les N' }).getByRole('button', { name: 'semaines', exact: true }).click();
    // Départ mer. 23 sept. : seul « Mercredi » est coché.
    await expect(form.getByRole('checkbox', { name: 'Mercredi', exact: true })).toBeChecked();
    await expect(form.getByRole('checkbox', { name: 'Lundi', exact: true })).not.toBeChecked();
    await form.getByRole('checkbox', { name: 'Mercredi', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await form.getByRole('checkbox', { name: 'Lundi', exact: true }).click();
    await form.getByRole('checkbox', { name: 'Jeudi', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    const card = cardOf(page, 'Courses');
    await expect(card).toContainText('toutes les 2 semaines : lun., jeu.');
    // Semaine du lun. 21 au dim. 27 sept., départ mer. 23 : jeu. 24 seulement de prévu (le lun. 21 précède le départ).
    const states = await card.getByRole('checkbox').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
    expect(states).toEqual(['off', 'off', 'off', 'planned', 'off', 'off', 'off']);
    await expect(card.locator('.ct-routine-card__counter')).toHaveText('0/1');
  });

  test('tous les 3 jours : visible dans Aujourd’hui aux seules dates prévues ; compteur de la semaine (critères 4, 6)', async ({ page }) => {
    await insertRoutines(page, [
      { title: 'Arroser', scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-21', done: ['2026-09-21'] },
      { title: 'Autre rythme', scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-22' },
    ]);
    await reopenRoutines(page);
    const card = cardOf(page, 'Arroser');
    // Semaine 21-27 sept. : 21, 24, 27 prévus ; 21 validé.
    await expect(card.locator('.ct-routine-card__counter')).toHaveText('1/3');
    const states = await card.getByRole('checkbox').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
    expect(states).toEqual(['done', 'off', 'off', 'planned', 'off', 'off', 'planned']);
    // Mercredi 23 : « Arroser » n'est pas prévu, « Autre rythme » (22, 25, 28…) non plus.
    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Arroser' })).toHaveCount(0);
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Autre rythme' })).toHaveCount(0);
  });

  test('les validations passées sont conservées quand N change (critère 8)', async ({ page }) => {
    await insertRoutines(page, [{ title: 'Arroser', scheduleType: 'every_n_days', interval: 3, startDate: '2026-09-21', done: ['2026-09-21'] }]);
    await reopenRoutines(page);
    await cardOf(page, 'Arroser').getByRole('button', { name: 'Éditer la routine Arroser' }).click();
    const form = routineForm(page, 'Modifier la routine');
    await expect(form.getByTestId('interval-value')).toHaveText('3');
    await form.getByRole('button', { name: 'Augmenter' }).click();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    const card = cardOf(page, 'Arroser');
    await expect(card).toContainText('tous les 4 jours');
    await expect(card.getByRole('checkbox', { name: 'Lundi, fait' })).toBeVisible();
  });
});
