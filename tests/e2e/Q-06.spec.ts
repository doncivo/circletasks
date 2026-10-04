import { expect, test } from '@playwright/test';
import { isPhone, openToday, rowOf } from './helpers/today';

/**
 * Q-06 et Q-02 — espace, projet, date et heure écrits dans la saisie.
 *
 * Couverture : suggestions « # » (combobox), aperçu sous le champ, tâche créée avec titre nettoyé, espace Perso, demain et heure
 * (PC : champ d'ajout ; iPhone : feuille « Nouvelle tâche »). Les cas fins (projets, ambiguïtés, 40 phrases) sont dans
 * `src/domain/quickInput.test.ts`, `naturalDate.test.ts` et `src/features/capture`.
 */
test.describe('Q-06 / Q-02 — saisie rapide', () => {
  test.beforeEach(async ({ page }) => {
    await openToday(page);
  });

  test('« # » propose les espaces, l’aperçu annonce Perso et demain 10:00, la tâche est créée nettoyée', async ({ page }, testInfo) => {
    const phone = isPhone(testInfo);
    const title = `Appeler le notaire ${phone ? 'iphone' : 'pc'}`;
    let field;
    if (phone) {
      await page.getByRole('button', { name: 'Ajouter' }).click();
      field = page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByLabel('Titre');
    } else {
      field = page.getByLabel('Nouvelle tâche');
    }
    await field.fill(`${title} demain 10h #pe`);
    const list = page.getByRole('listbox', { name: 'Suggestions' });
    await expect(list.getByRole('option')).toHaveText(['#Perso']);
    await field.press('Enter');
    await expect(field).toHaveValue(`${title} demain 10h #Perso `);
    const preview = page.getByRole('group', { name: 'Ce qui sera appliqué' });
    await expect(preview).toContainText('demain · 10:00');
    await expect(preview).toContainText('Perso');
    if (phone) {
      await page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByRole('button', { name: 'Enregistrer' }).click();
    } else {
      await field.press('Enter');
      await expect(field).toHaveValue('');
    }
    // La tâche est datée de demain : elle n'est pas dans la liste du jour, mais dans celle de demain.
    await expect(rowOf(page, title)).toHaveCount(0);
    if (phone) return;
    await page.getByRole('button', { name: 'Jour suivant' }).click();
    const row = rowOf(page, title);
    await expect(row).toBeVisible();
    await expect(row.locator('.ct-list-row__subtitle, .ct-list-row__meta')).toHaveText('10:00 · Perso');
  });

  test('Échap ferme les suggestions sans effacer la saisie ; « #pro » seul ne crée rien', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Parcours PC : champ d’ajout en ligne');
    const field = page.getByLabel('Nouvelle tâche');
    await field.fill('Lire #p');
    await expect(page.getByRole('listbox', { name: 'Suggestions' })).toBeVisible();
    await field.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(field).toHaveValue('Lire #p');
    await field.fill('#pro');
    // Premier Entrée : complète le mot (« #Pro ») ; le second tente de créer : le titre serait vide, rien n'est créé.
    await field.press('Enter');
    await expect(field).toHaveValue('#Pro ');
    await field.press('Enter');
    await expect(field).toHaveValue('#Pro ');
    await expect(page.getByText('Rien de prévu aujourd’hui.')).toBeVisible();
  });
});
