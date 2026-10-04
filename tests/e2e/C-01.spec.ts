import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { addField, chooseChecklist, createChecklist, insertChecklists, itemTexts, openChecklists, reopenChecklists } from './helpers/checklists';
import { isPhone } from './helpers/today';

/**
 * C-01 — Je crée une checklist nommée.
 *
 * Couverture : état vide ; « + » (iPhone) / « + Nouvelle checklist » (PC) ouvre la feuille, « Créer » inactif sans titre ; la
 * checklist créée est ouverte avec le focus dans « Nouvel élément » ; items ajoutés à la chaîne par Entrée ; choix de la checklist
 * (pastille iPhone, volet PC) ; filtre d'espace ; suppression annulable. Exécuté sur `pc` et `iphone`. La persistance au redémarrage
 * est couverte par les tests d'intégration (la base du navigateur de développement est en mémoire).
 */
test.describe('C-01 — créer une checklist', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test('état vide, puis feuille « Nouvelle checklist » : Créer inactif sans titre (critères 1, 7)', async ({ page }, testInfo) => {
    await openChecklists(page);
    await expect(page.getByText('Aucune checklist pour l’instant', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: isPhone(testInfo) ? 'Nouvelle checklist' : '+ Nouvelle checklist', exact: true }).click();
    const form = page.getByRole('form', { name: 'Nouvelle checklist' });
    await expect(form).toBeVisible();
    await expect(form.getByRole('button', { name: 'Créer' })).toBeDisabled();
    await form.getByLabel('Titre de la checklist').fill('Valise voyage');
    await expect(form.getByRole('button', { name: 'Créer' })).toBeEnabled();
    await expect(form.getByRole('radiogroup', { name: 'Icône' })).toBeVisible();
    await expect(form.getByRole('group', { name: 'Espace de la checklist' })).toBeVisible();
  });

  test('créer ouvre la checklist vide, focus dans « Nouvel élément » ; Entrée enchaîne les items (critères 2, 3)', async ({ page }) => {
    await openChecklists(page);
    await page.getByRole('button', { name: /Nouvelle checklist$/ }).click();
    const form = page.getByRole('form', { name: 'Nouvelle checklist' });
    await form.getByLabel('Titre de la checklist').fill('Valise voyage');
    await form.getByRole('button', { name: 'Créer' }).click();
    await expect(form).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Valise voyage', exact: true })).toBeVisible();
    await expect(addField(page)).toBeFocused();
    expect(await itemTexts(page)).toEqual([]);

    await page.keyboard.type('Passeport');
    await page.keyboard.press('Enter');
    await expect(addField(page)).toHaveValue('');
    await expect(addField(page)).toBeFocused();
    await page.keyboard.type('Chargeur');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // champ vide : rien
    await page.keyboard.type('   ');
    await page.keyboard.press('Enter'); // blanc : rien
    await page.keyboard.type('Billets d’avion');
    await page.keyboard.press('Enter');
    await expect.poll(() => itemTexts(page)).toEqual(['Passeport', 'Chargeur', 'Billets d’avion']);
  });

  test('« Ajouté dans Perso » quand l’espace choisi diffère du filtre (critère 2)', async ({ page }, testInfo) => {
    await openChecklists(page);
    await page.getByRole('button', { name: 'Pro', exact: true }).first().click();
    await createChecklist(page, testInfo, 'Courses', 'Perso');
    await expect(page.getByText('Ajouté dans Perso')).toBeVisible();
  });

  test('plusieurs checklists : choix par la pastille (iPhone) ou le volet (PC), tri par titre, « cochés / total » (critère 4)', async ({ page }, testInfo) => {
    await insertChecklists(page, [
      { title: 'Zèbre', items: ['a'] },
      { title: 'abeille', items: [['x', true], 'y'] },
      { title: 'Éclair', space: 'perso' },
    ]);
    await reopenChecklists(page);
    if (isPhone(testInfo)) {
      const options = await page.getByRole('combobox', { name: 'Choisir une checklist' }).locator('option').allTextContents();
      expect(options.map((text) => text.split(' · ')[0])).toEqual(['abeille', 'Éclair', 'Zèbre']);
    } else {
      const names = await page.getByRole('list', { name: 'Mes checklists' }).locator('.ct-checklist-list__name').allTextContents();
      expect(names).toEqual(['abeille', 'Éclair', 'Zèbre']);
      await expect(page.getByRole('list', { name: 'Mes checklists' }).getByRole('button', { name: /^abeille/ })).toContainText('1 / 2');
    }
    await chooseChecklist(page, testInfo, 'Zèbre');
    await expect.poll(() => itemTexts(page)).toEqual(['a']);
    // La sélection est conservée en changeant d’onglet.
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Routines', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Checklists', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Zèbre', exact: true })).toBeVisible();
  });

  test('le filtre d’espace ne garde que les checklists de l’espace (critère 5)', async ({ page }, testInfo) => {
    await insertChecklists(page, [{ title: 'Dossier', space: 'pro' }, { title: 'Courses', space: 'perso' }]);
    await reopenChecklists(page);
    await page.getByRole('button', { name: 'Perso', exact: true }).click();
    if (isPhone(testInfo)) {
      await expect(page.getByRole('combobox', { name: 'Choisir une checklist' }).locator('option')).toHaveText(['Courses']);
    } else {
      await expect(page.getByRole('list', { name: 'Mes checklists' }).locator('.ct-checklist-list__name')).toHaveText(['Courses']);
    }
    await page.getByRole('button', { name: 'Pro', exact: true }).first().click();
    await expect(page.getByText('Dossier').first()).toBeVisible();
    await expect(page.getByText('Courses')).toHaveCount(0);
  });

  test('supprimer depuis la feuille Modifier : confirmation, puis « Annuler » restaure (critère 6)', async ({ page }) => {
    await insertChecklists(page, [{ title: 'Valise voyage', items: ['Passeport', 'Chargeur'] }]);
    await reopenChecklists(page);
    await expect.poll(() => itemTexts(page)).toEqual(['Passeport', 'Chargeur']);
    await page.getByRole('button', { name: 'Modifier la checklist' }).click();
    const form = page.getByRole('form', { name: 'Modifier la checklist' });
    await form.getByRole('button', { name: 'Supprimer la checklist' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Supprimer « Valise voyage » ?' });
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    await expect(confirm).not.toBeVisible();
    await form.getByRole('button', { name: 'Supprimer la checklist' }).click();
    await confirm.getByRole('button', { name: 'Supprimer' }).click();
    await expect(page.getByText('Aucune checklist pour l’instant', { exact: true })).toBeVisible();
    await expect(page.getByText('« Valise voyage » supprimée')).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Valise voyage', exact: true })).toBeVisible();
    await expect.poll(() => itemTexts(page)).toEqual(['Passeport', 'Chargeur']);
  });

  test('cibles tactiles de 44 pt au moins sur iPhone (critère 8)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'iPhone seulement');
    await insertChecklists(page, [{ title: 'Valise voyage', items: ['Passeport'] }]);
    await reopenChecklists(page);
    for (const name of ['Modifier la checklist', 'Nouvelle checklist']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    const chooser = await page.getByRole('combobox', { name: 'Choisir une checklist' }).boundingBox();
    expect(chooser?.height).toBeGreaterThanOrEqual(44);
  });
});
