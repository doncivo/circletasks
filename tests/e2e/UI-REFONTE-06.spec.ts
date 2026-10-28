import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { addField, insertChecklists, itemTexts, reopenChecklists } from './helpers/checklists';
import { expectFitsViewport } from './helpers/layout';

/**
 * UI-REFONTE-06 — Checklists sur iPhone (docs/maquettes-refonte/Checklists-v2.html) : le sélecteur est le titre, « + » et crayon à sa
 * droite, progression « 2 sur 3 » avec « Réorganiser », un seul champ d'ajout, libellés du bas avec le compte, thème sombre, largeur.
 * Projets `iphone` et `iphone-webkit` ; le PC est couvert par C-01 à C-05.
 */

const onPhone = (): boolean => test.info().project.name.startsWith('iphone');

test.describe('UI-REFONTE-06 — Checklists iPhone', () => {
  test.beforeEach(() => {
    test.skip(!onPhone(), 'Mise en page iPhone seulement.');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`thème ${scheme} : titre-sélecteur, progression, champ unique, libellés du bas (critères 1 à 6)`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openApp(page);
      await insertChecklists(page, [{ title: 'Course maison', space: 'perso', items: [['Carotte', true], ['Mangue', true], 'Banane'] }, { title: 'Valise', space: 'perso', items: ['Passeport'] }]);
      await reopenChecklists(page);
      const title = page.getByRole('heading', { level: 1, name: 'Course maison' });
      await expect(title).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Course maison' })).toHaveCount(1);
      const chooser = page.getByRole('combobox', { name: 'Choisir une checklist' });
      await expect(chooser).toHaveCount(1);
      const row = page.locator('.ct-checklists__topRow');
      await expect(row.getByRole('button', { name: 'Nouvelle checklist' })).toBeVisible();
      await expect(row.getByRole('button', { name: 'Modifier la checklist' })).toBeVisible();
      await expect(page.locator('.ct-checklist-detail__head')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Vue compacte' })).toHaveCount(0);
      await expect(page.locator('.ct-fab')).toHaveCount(0);

      const progress = page.locator('.ct-checklist-progress');
      await expect(progress.getByRole('status')).toHaveText('2 sur 3');
      await expect(progress.getByRole('button', { name: 'Réorganiser' })).toBeVisible();
      const bar = await progress.getByRole('progressbar').boundingBox();
      expect(bar && bar.height <= 8).toBeTruthy();

      const batch = page.locator('.ct-checklist-detail__batch');
      const clear = batch.getByRole('button', { name: 'Supprimer les 2 éléments cochés' });
      await expect(clear).toBeVisible();
      await expect(clear).toHaveAttribute('data-variant', 'danger');
      await expect(batch.getByRole('button', { name: 'Tout décocher' })).toBeVisible();

      // Un seul moyen d'ajouter : le champ, Entrée enchaîne.
      await addField(page).fill('Pomme');
      await addField(page).press('Enter');
      await expect.poll(() => itemTexts(page)).toEqual(['Carotte', 'Mangue', 'Banane', 'Pomme']);
      await expect(progress.getByRole('status')).toHaveText('2 sur 4');
      await expect(addField(page)).toHaveValue('');

      // Tout décocher : libellés inactifs et sans compte.
      await batch.getByRole('button', { name: 'Tout décocher' }).click();
      await expect(progress.getByRole('status')).toHaveText('0 sur 4');
      await expect(batch.getByRole('button', { name: 'Supprimer les éléments cochés' })).toHaveAttribute('aria-disabled', 'true');

      // Le sélecteur change de checklist : le titre suit.
      const option = chooser.locator('option').filter({ hasText: 'Valise' }).first();
      await chooser.selectOption(await option.getAttribute('value'));
      await expect(page.getByRole('heading', { level: 1, name: 'Valise' })).toBeVisible();
      const box = await batch.boundingBox();
      const viewport = page.viewportSize();
      expect(box && viewport && box.y + box.height <= viewport.height).toBeTruthy();
      await expectFitsViewport(page, `Checklists (${scheme})`);
    });
  }

  test('« Supprimer les 2 éléments cochés » : confirmation puis effacement, annulable (critère 5)', async ({ page }) => {
    await openApp(page);
    await insertChecklists(page, [{ title: 'Course maison', items: [['Carotte', true], ['Mangue', true], 'Banane'] }]);
    await reopenChecklists(page);
    await page.locator('.ct-checklist-detail__batch').getByRole('button', { name: 'Supprimer les 2 éléments cochés' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Effacer 2 éléments cochés ?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Effacer' }).click();
    await expect.poll(() => itemTexts(page)).toEqual(['Banane']);
    await expect(page.getByRole('status').filter({ hasText: 'éléments effacés' })).toContainText('2 éléments effacés');
    await page.getByRole('button', { name: 'Annuler' }).click();
    await expect.poll(() => itemTexts(page)).toEqual(['Carotte', 'Mangue', 'Banane']);
  });
});
