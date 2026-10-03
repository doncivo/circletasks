import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertChecklists, openChecklists, reopenChecklists } from './helpers/checklists';
import { addIsoDays, browserToday } from './helpers/schedule';
import { isPhone } from './helpers/today';
import { dayOf, openWeek } from './helpers/week';

/**
 * C-03 — J'associe une checklist à un jour.
 *
 * Couverture : sélecteur de date (PC : « Planifier un jour » ; iPhone : feuille « Modifier la checklist ») ; ligne « 3/6 » dans
 * Aujourd'hui et dans la colonne du jour de la Semaine ; la toucher ouvre l'onglet Checklists sur elle ; date passée et sans date
 * absentes ; filtre d'espace ; « Retirer la date » annulable. Exécuté sur `pc` et `iphone`.
 */
const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;

const todayRow = (page: Page, title: string) => page.locator('.ct-today-checklists__item').filter({ hasText: title });

test.describe('C-03 — checklist associée à un jour', () => {
  test('visible dans Aujourd’hui avec « 3/6 » ; la toucher ouvre l’onglet sur elle ; date passée et sans date absentes (critères 2, 3, 5, 8)', async ({ page }) => {
    await openApp(page);
    const today = await browserToday(page);
    await insertChecklists(page, [
      { title: 'Valise voyage', date: today, items: VALISE },
      { title: 'Hier', date: addIsoDays(today, -1), items: ['a'] },
      { title: 'Sans date', items: ['a'] },
      { title: 'Terminée', date: today, items: [['a', true], ['b', true]] },
    ]);
    await openWeek(page);
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(todayRow(page, 'Valise voyage')).toContainText('3/6');
    await expect(todayRow(page, 'Terminée')).toContainText('2/2');
    await expect(page.getByText('Hier', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Sans date', { exact: true })).toHaveCount(0);

    await todayRow(page, 'Valise voyage').click();
    await expect(page.getByRole('heading', { name: 'Valise voyage', exact: true })).toBeVisible();
    await expect(page.getByText(`Prévue le`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true })).toBeVisible();
  });

  test('cocher depuis le détail met à jour la ligne d’Aujourd’hui et de la Semaine (critère 4)', async ({ page }, testInfo) => {
    await openApp(page);
    const today = await browserToday(page);
    await insertChecklists(page, [{ title: 'Valise voyage', date: today, items: VALISE }]);
    await openWeek(page);
    await expect(dayOf(page, today).getByRole('button', { name: 'Ouvrir la checklist : Valise voyage' })).toBeVisible();
    if (isPhone(testInfo)) await expect(dayOf(page, today)).toContainText('3/6');
    else await expect(dayOf(page, today)).toContainText('checklist 3/6');
    await dayOf(page, today).getByRole('button', { name: 'Ouvrir la checklist : Valise voyage' }).click();
    await page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true }).click();
    await expect(page.getByText('4 / 6').first()).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(todayRow(page, 'Valise voyage')).toContainText('4/6');
    await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
    await expect(dayOf(page, today)).toContainText(isPhone(testInfo) ? '4/6' : 'checklist 4/6');
  });

  test('planifier un jour puis le retirer, annulable (critères 1, 2, 6, 9)', async ({ page }, testInfo) => {
    await openApp(page);
    await insertChecklists(page, [{ title: 'Valise voyage', items: VALISE }]);
    await reopenChecklists(page);
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Modifier la checklist' }).click();
      await page.getByRole('button', { name: 'Date : Aucune date' }).click();
      const dialog = page.getByRole('dialog', { name: 'Planifier un jour' });
      await dialog.getByRole('button', { name: /^Aujourd.hui/ }).click();
      await dialog.getByRole('button', { name: 'Planifier' }).click();
      await expect(page.getByRole('form', { name: 'Modifier la checklist' }).getByRole('button', { name: /^Date : / })).not.toHaveText('Aucune date');
      await page.getByRole('form', { name: 'Modifier la checklist' }).getByRole('button', { name: 'Fermer' }).click();
    } else {
      await page.getByRole('button', { name: 'Planifier un jour', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Planifier un jour' });
      await expect(dialog.getByRole('button', { name: /Un jour/ })).toHaveCount(0);
      await dialog.getByRole('textbox', { name: 'Date' }).fill('aujourd’hui');
      await dialog.getByRole('button', { name: 'Planifier' }).click();
    }
    await expect(page.getByText(/^Prévue le /)).toBeVisible();
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(todayRow(page, 'Valise voyage')).toContainText('3/6');

    await openChecklists(page);
    if (isPhone(testInfo)) {
      await page.getByRole('button', { name: 'Modifier la checklist' }).click();
      await page.getByRole('button', { name: 'Retirer la date' }).click();
      await page.getByRole('form', { name: 'Modifier la checklist' }).getByRole('button', { name: 'Fermer' }).click();
    } else {
      await page.getByRole('button', { name: 'Retirer la date', exact: true }).click();
    }
    await expect(page.getByText('Date retirée de « Valise voyage »')).toBeVisible();
    await expect(page.getByText(/^Prévue le /)).toHaveCount(0);
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(todayRow(page, 'Valise voyage')).toHaveCount(0);
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(todayRow(page, 'Valise voyage')).toContainText('3/6');
  });

  test('le filtre d’espace s’applique ; « Tout » écrit l’espace dans la ligne (critère 7)', async ({ page }) => {
    await openApp(page);
    const today = await browserToday(page);
    await insertChecklists(page, [
      { title: 'Dossier', space: 'pro', date: today, items: ['a'] },
      { title: 'Courses', space: 'perso', date: today, items: ['a'] },
    ]);
    await openWeek(page);
    await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
    await expect(todayRow(page, 'Courses')).toContainText('Perso');
    await page.getByRole('button', { name: 'Pro', exact: true }).click();
    await expect(todayRow(page, 'Dossier')).toBeVisible();
    await expect(todayRow(page, 'Courses')).toHaveCount(0);
  });
});
