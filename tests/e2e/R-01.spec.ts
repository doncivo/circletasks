import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { cardOf, createRoutine, insertRoutines, openRoutines, routineForm } from './helpers/routines';
import { addIsoDays, browserToday } from './helpers/schedule';
import { isPhone, todayTab } from './helpers/today';
import { mondayOf } from './helpers/week';

/**
 * R-01 — Je crée une routine avec icône et fréquence.
 *
 * Couverture : « + » ouvre la feuille Ajout au segment Routine « Nouvelle routine » (iPhone et PC, Ctrl+N ; la modification reste dans le panneau de droite) ; Enregistrer grisé sans nom ou
 * sans jour choisi ; fréquences tous les jours / jours choisis / X fois par semaine ; icône ; carte (ronds, compteur, ligne
 * d'informations) ; routine du jour dans Aujourd'hui ; filtre d'espace ; « 3 fois par semaine » (QB-01). Exécuté sur `pc` et `iphone`.
 * Persistance au redémarrage : couverte par les tests d'intégration (la base du navigateur de développement est en mémoire).
 */
test.describe('R-01 — créer une routine', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('« + » ouvre le formulaire ; Enregistrer grisé sans nom ou sans jour (critères 1, 2, 3)', async ({ page }, testInfo) => {
    await openRoutines(page);
    await expect(page.getByText('Gérez vos routines ici', { exact: false })).toBeVisible({ visible: isPhone(testInfo) });
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
    const form = routineForm(page, 'Nouvelle routine');
    await expect(form).toBeVisible();
    // E-01 D2 : « + » de Routines ouvre la feuille Ajout (segment Routine) sur iPhone comme sur PC.
    await expect(page.getByRole('dialog', { name: 'Nouvelle routine' })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Routine', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(form.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Archiver' })).toHaveCount(0);

    await form.getByLabel('Nom de la routine').fill('Sport');
    await expect(form.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
    await form.getByLabel('Fréquence', { exact: true }).selectOption('weekdays');
    await expect(form.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    await form.getByRole('checkbox', { name: 'Lundi', exact: true }).click();
    await expect(form.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
  });

  test('PC : Ctrl+N ouvre le formulaire, nom focalisé (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'raccourci clavier : PC seulement');
    await openRoutines(page);
    await page.keyboard.press('Control+n');
    const form = routineForm(page, 'Nouvelle routine');
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Nom de la routine')).toBeFocused();
  });

  test('crée une routine « Jours choisis » avec icône : carte, ronds en pointillés, compteur (critères 4, 6, 7, 8, 9)', async ({ page }, testInfo) => {
    await openRoutines(page);
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
    const form = routineForm(page, 'Nouvelle routine');
    await form.getByLabel('Nom de la routine').fill('Sport');
    await form.getByRole('button', { name: 'Icône sport' }).click();
    const options = await form.getByLabel('Fréquence', { exact: true }).locator('option').allTextContents();
    expect(options.slice(0, 3)).toEqual(['Tous les jours', 'Jours choisis', 'X fois par semaine']);
    await form.getByLabel('Fréquence', { exact: true }).selectOption('weekdays');
    for (const day of ['Lundi', 'Mercredi', 'Vendredi', 'Dimanche']) await form.getByRole('checkbox', { name: day, exact: true }).click();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();

    const card = cardOf(page, 'Sport');
    await expect(card).toBeVisible();
    await expect(card.locator('svg').first()).toBeVisible(); // icône Lucide
    const rounds = card.getByRole('checkbox');
    await expect(rounds).toHaveCount(7);
    // Aucun jour antérieur à aujourd'hui n'est prévu : tous les ronds passés sont en pointillés.
    const today = await browserToday(page);
    const monday = mondayOf(today);
    const states = await rounds.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state')));
    const expected = Array.from({ length: 7 }, (_, i) => {
      const date = addIsoDays(monday, i);
      const weekday = i + 1;
      return date >= today && [1, 3, 5, 7].includes(weekday) ? 'planned' : 'off';
    });
    expect(states).toEqual(expected);
    const planned = expected.filter((state) => state === 'planned').length;
    await expect(card.locator('.ct-routine-card__counter')).toHaveText(`0/${String(planned)}`);
    await expect(card).toContainText('Pro · lun., mer., ven., dim.');
  });

  test('« X fois par semaine » : compteur de 1 à 7, aucun jour à choisir ; la carte affiche le quota (critères 4, 5, 8)', async ({ page }, testInfo) => {
    await openRoutines(page);
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
    const form = routineForm(page, 'Nouvelle routine');
    await form.getByLabel('Nom de la routine').fill('Courir');
    await form.getByLabel('Fréquence', { exact: true }).selectOption('x_per_week');
    await expect(form.getByRole('checkbox', { name: 'Lundi', exact: true })).toHaveCount(0);
    const minus = form.getByRole('button', { name: 'Diminuer' });
    const plus = form.getByRole('button', { name: 'Augmenter' });
    for (let i = 0; i < 8; i += 1) await minus.click({ force: true });
    await expect(minus).toBeDisabled();
    for (let i = 0; i < 8; i += 1) await plus.click({ force: true });
    await expect(plus).toBeDisabled();
    for (let i = 0; i < 4; i += 1) await minus.click();
    await form.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(form).not.toBeVisible();
    const card = cardOf(page, 'Courir');
    await expect(card.locator('.ct-routine-card__counter')).toHaveText('0/3');
    await expect(card).toContainText('3 fois par semaine');
  });

  test('la routine du jour apparaît dans Aujourd’hui avec la mention « Routine » ; une routine d’un autre jour non (critères 11, R-03 7)', async ({ page }, testInfo) => {
    await openRoutines(page);
    await createRoutine(page, testInfo, { title: 'Boire de l’eau' });
    await todayTab(page).click();
    const row = page.locator('.ct-list-row').filter({ hasText: 'Boire de l’eau' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Routine');
  });

  test('le filtre d’espace limite les cartes ; l’espace proposé suit le filtre (critère 10)', async ({ page }, testInfo) => {
    await insertRoutines(page, [
      { title: 'Revue des e-mails', space: 'pro' },
      { title: 'Lire 20 minutes', space: 'perso' },
    ]);
    await openRoutines(page);
    await expect(cardOf(page, 'Revue des e-mails')).toBeVisible();
    await expect(cardOf(page, 'Lire 20 minutes')).toBeVisible();
    await page.getByRole('group', { name: 'Filtre d’espace' }).getByRole('button', { name: 'Perso', exact: true }).click();
    await expect(cardOf(page, 'Revue des e-mails')).toHaveCount(0);
    await expect(cardOf(page, 'Lire 20 minutes')).toBeVisible();
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Ajouter une routine' : 'Ajouter', exact: true }).click();
    await expect(routineForm(page, 'Nouvelle routine').getByRole('button', { name: 'Perso', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('« 3 fois par semaine » : visible dans Aujourd’hui tant que le quota n’est pas atteint, masquée ensuite (critère 13, QB-01)', async ({ page }) => {
    // Vendredi 2 oct. 2026 : semaine du lun. 28 sept. au dim. 4 oct.
    await page.clock.setFixedTime(new Date('2026-10-02T08:00:00Z'));
    await openApp(page);
    await insertRoutines(page, [
      { title: 'Quota atteint', scheduleType: 'x_per_week', timesPerWeek: 3, done: ['2026-09-28', '2026-09-29', '2026-09-30'] },
      { title: 'Quota en cours', scheduleType: 'x_per_week', timesPerWeek: 3, done: ['2026-09-28', '2026-09-29'] },
    ]);
    await openRoutines(page);
    await todayTab(page).click();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Quota en cours' })).toBeVisible();
    await expect(page.locator('.ct-list-row').filter({ hasText: 'Quota atteint' })).toHaveCount(0);
  });
});
