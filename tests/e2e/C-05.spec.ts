import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { insertChecklists, itemTexts, reopenChecklists } from './helpers/checklists';
import { isPhone } from './helpers/today';

/**
 * C-05 — J'efface d'un coup les items cochés.
 *
 * Couverture : « Effacer les cochés » avec confirmation (Annuler / Effacer), message « 3 éléments effacés » annulable (bouton et
 * Ctrl+Z), focus rendu au bouton ; boutons inactifs sans item coché ; « Tout décocher » annulable ; mode « Réorganiser » (poignées,
 * « − », « Terminer ») ; glisser une poignée, flèches sur la poignée, Alt+↑ / Alt+↓ ; « − » annulable. Exécuté sur `pc` et `iphone`.
 */
const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;
const ALL = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', 'Passeport', 'Chargeur', 'Billets d’avion'];

test.describe('C-05 — effacer les cochés, tout décocher, réorganiser', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await insertChecklists(page, [{ title: 'Valise voyage', items: VALISE }]);
    await reopenChecklists(page);
    await expect(page.getByText('3 / 6').first()).toBeVisible();
  });

  test('confirmation, effacement de 3 éléments, « 0 / 3 », Annuler restaure à leur place (critères 1, 2, 9)', async ({ page }) => {
    const clear = page.getByRole('button', { name: 'Effacer les cochés', exact: true });
    await clear.click();
    const dialog = page.getByRole('alertdialog', { name: 'Effacer 3 éléments cochés ?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Annuler' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(clear).toBeFocused();
    expect(await itemTexts(page)).toEqual(ALL);

    await clear.click();
    await dialog.getByRole('button', { name: 'Effacer' }).click();
    await expect(page.getByText('3 éléments effacés')).toBeVisible();
    await expect.poll(() => itemTexts(page)).toEqual(ALL.slice(0, 3));
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('0 / 3');
    await expect(clear).toBeFocused();
    await expect(clear).toHaveAttribute('aria-disabled', 'true');

    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect.poll(() => itemTexts(page)).toEqual(ALL);
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('3 / 6');
  });

  test('Ctrl+Z restaure les éléments effacés (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'clavier : PC seulement');
    await page.getByRole('button', { name: 'Effacer les cochés', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Effacer' }).click();
    await expect.poll(() => itemTexts(page)).toHaveLength(3);
    await page.keyboard.press('Control+z');
    await expect.poll(() => itemTexts(page)).toEqual(ALL);
  });

  test('« Tout décocher » : sans confirmation, « 0 / 6 », annulable ; boutons inactifs ensuite (critères 3, 4)', async ({ page }) => {
    const uncheck = page.getByRole('button', { name: 'Tout décocher', exact: true });
    await uncheck.click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('0 / 6');
    await expect(page.getByText('Éléments décochés')).toBeVisible();
    await expect(uncheck).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('button', { name: 'Effacer les cochés', exact: true })).toHaveAttribute('aria-disabled', 'true');
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('3 / 6');
    await expect(uncheck).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('« Réorganiser » : poignées et « − », « Terminer » ; « − » supprime avec « Annuler » (critères 5, 7)', async ({ page }, testInfo) => {
    const handle = page.getByRole('button', { name: 'Déplacer : Crème solaire', exact: true });
    if (isPhone(testInfo)) await expect(handle).toHaveCount(0);
    else await expect(handle).toBeVisible();
    await expect(page.getByRole('button', { name: /^Supprimer : / })).toHaveCount(0);
    await page.getByRole('button', { name: 'Réorganiser', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Terminer', exact: true })).toBeVisible();
    await expect(handle).toBeVisible();
    await page.getByRole('button', { name: 'Supprimer : Crème solaire', exact: true }).click();
    await expect(page.getByText('« Crème solaire » supprimé')).toBeVisible();
    await expect.poll(() => itemTexts(page)).toEqual(ALL.filter((text) => text !== 'Crème solaire'));
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect.poll(() => itemTexts(page)).toEqual(ALL);
    await page.getByRole('button', { name: 'Terminer', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Supprimer : / })).toHaveCount(0);
  });

  test('glisser une poignée change l’item de place, annulable (critère 6)', async ({ page }, testInfo) => {
    if (isPhone(testInfo)) await page.getByRole('button', { name: 'Réorganiser', exact: true }).click();
    const handle = page.getByRole('button', { name: 'Déplacer : Billets d’avion', exact: true });
    const target = page.locator('.ct-checklist-item').first();
    const from = await handle.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error('éléments introuvables');
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y - 40, { steps: 4 });
    await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => itemTexts(page)).toEqual(['Billets d’avion', ...ALL.slice(0, 5)]);
    await expect(page.getByText('Élément déplacé')).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect.poll(() => itemTexts(page)).toEqual(ALL);
  });

  test('clavier : ↑ sur la poignée et Alt+↓ sur la ligne sélectionnée déplacent l’item (critère 6)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'clavier : PC seulement');
    const handle = page.getByRole('button', { name: 'Déplacer : Crème solaire', exact: true });
    await handle.focus();
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => itemTexts(page)).toEqual(['Crème solaire', 'Adaptateur de prise', ...ALL.slice(2)]);
    await expect(page.getByRole('button', { name: 'Déplacer : Crème solaire', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => itemTexts(page)).toEqual(ALL);
  });
});
