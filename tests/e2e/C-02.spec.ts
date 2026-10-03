import { expect, test } from '@playwright/test';
import { openApp } from './helpers/app';
import { addField, chooseChecklist, insertChecklists, itemTexts, openChecklists, reopenChecklists } from './helpers/checklists';
import { isPhone } from './helpers/today';

/**
 * C-02 — Je coche des items.
 *
 * Couverture : « 3 / 6 » et barre à 50 % ; case (toucher, clic, Espace) : « 4 / 6 » sans recharger, texte barré, `aria-pressed` et nom
 * « Cocher / Décocher : … » ; deux gestes rapides ; items cochés à leur place ; texte modifiable en ligne ; « 0 / 0 » sans barre ;
 * vue compacte ; état conservé en changeant d'onglet. Exécuté sur `pc` et `iphone`. Le redémarrage de l'app est couvert par les tests
 * d'intégration (la base du navigateur de développement est en mémoire).
 */
const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;

test.describe('C-02 — cocher des items', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await insertChecklists(page, [{ title: 'Valise voyage', items: VALISE }]);
    await reopenChecklists(page);
    await expect(page.getByText('3 / 6').first()).toBeVisible();
  });

  test('barre à 50 %, « 3 / 6 » dans le détail (et dans le volet sur PC) (critère 1)', async ({ page }, testInfo) => {
    const bar = page.getByRole('progressbar', { name: 'Progression : 3 sur 6' });
    await expect(bar).toHaveAttribute('aria-valuenow', '3');
    const box = await bar.boundingBox();
    const fill = await bar.locator('.ct-checklist-progress__fill').boundingBox();
    expect(Math.abs((fill?.width ?? 0) / (box?.width ?? 1) - 0.5)).toBeLessThan(0.02);
    if (!isPhone(testInfo)) await expect(page.getByRole('list', { name: 'Mes checklists' })).toContainText('3 / 6');
  });

  test('cocher met à jour la progression sans recharger ; décocher la rétablit (critère 2)', async ({ page }) => {
    const box = page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true });
    await expect(box).toHaveAttribute('aria-pressed', 'false');
    await box.click();
    await expect(page.getByText('4 / 6').first()).toBeVisible();
    const done = page.getByRole('button', { name: 'Décocher : Crème solaire', exact: true });
    await expect(done).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Modifier : Crème solaire' })).toHaveCSS('text-decoration-line', 'line-through');
    await done.click();
    await expect(page.getByText('3 / 6').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Modifier : Crème solaire' })).not.toHaveCSS('text-decoration-line', 'line-through');
  });

  test('Espace sur la case focalisée coche l’item (critère 2)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'clavier : PC seulement');
    await page.getByRole('button', { name: 'Cocher : Adaptateur de prise', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByText('4 / 6').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Décocher : Adaptateur de prise', exact: true })).toBeFocused();
  });

  test('deux clics rapides : état final du dernier geste ; items cochés à leur place (critères 3, 4)', async ({ page }) => {
    const box = page.getByRole('button', { name: /^(Cocher|Décocher) : Crème solaire$/ });
    await box.dblclick();
    await expect(page.getByText('3 / 6').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true }).click();
    expect(await itemTexts(page)).toEqual(['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', 'Passeport', 'Chargeur', 'Billets d’avion']);
  });

  test('le texte se modifie en ligne : Entrée valide, Échap annule, vide refusé (critère 5)', async ({ page }) => {
    await page.getByRole('button', { name: 'Modifier : Passeport', exact: true }).click();
    const field = page.getByLabel('Texte de l’élément');
    await expect(field).toBeFocused();
    await field.fill('Passeport valide');
    await field.press('Escape');
    expect(await itemTexts(page)).toContain('Passeport');
    await page.getByRole('button', { name: 'Modifier : Passeport', exact: true }).click();
    await page.getByLabel('Texte de l’élément').fill('   ');
    await page.getByLabel('Texte de l’élément').press('Enter');
    await expect(page.getByText('Un élément ne peut pas être vide.')).toBeAttached();
    await page.getByLabel('Texte de l’élément').fill('Passeport valide');
    await page.getByLabel('Texte de l’élément').press('Enter');
    await expect.poll(() => itemTexts(page)).toContain('Passeport valide');
    await expect(page.getByText('3 / 6').first()).toBeVisible();
  });

  test('l’état coché est conservé en changeant d’onglet (critère 8)', async ({ page }) => {
    await page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true }).click();
    await expect(page.getByText('4 / 6').first()).toBeVisible();
    await page.getByRole('navigation', { name: 'Navigation principale' }).getByRole('button', { name: 'Routines', exact: true }).click();
    await openChecklists(page);
    await expect(page.getByText('4 / 6').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Décocher : Crème solaire', exact: true })).toBeVisible();
  });

  test('vue compacte : lignes plus basses, cases de 44 pt (critère 9)', async ({ page }) => {
    const row = page.locator('.ct-checklist-item').first();
    const before = (await row.boundingBox())?.height ?? 0;
    await page.getByRole('button', { name: 'Vue compacte' }).click();
    await expect(page.getByRole('button', { name: 'Vue compacte' })).toHaveAttribute('aria-pressed', 'true');
    const after = (await row.boundingBox())?.height ?? 0;
    expect(after).toBeLessThan(before);
    const check = (await page.getByRole('button', { name: 'Cocher : Adaptateur de prise', exact: true }).boundingBox()) ?? { width: 0, height: 0 };
    expect(check.width).toBeGreaterThanOrEqual(44);
    expect(check.height).toBeGreaterThanOrEqual(44);
  });

  test('cibles tactiles de 44 pt (critère 2)', async ({ page }) => {
    const check = (await page.getByRole('button', { name: 'Cocher : Crème solaire', exact: true }).boundingBox()) ?? { width: 0, height: 0 };
    expect(check.width).toBeGreaterThanOrEqual(44);
    expect(check.height).toBeGreaterThanOrEqual(44);
    await expect(addField(page)).toBeVisible();
  });
});

test.describe('C-02 — états limites', () => {
  test('sans item : « 0 / 0 » et barre masquée ; tout coché : barre pleine (critère 6)', async ({ page }, testInfo) => {
    await openApp(page);
    await insertChecklists(page, [{ title: 'Vide' }, { title: 'Pleine', items: [['a', true], ['b', true]] }]);
    await reopenChecklists(page);
    await expect(page.getByText('2 / 2').first()).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    const full = await page.getByRole('progressbar').boundingBox();
    const fill = await page.locator('.ct-checklist-progress__fill').boundingBox();
    expect(fill?.width).toBeCloseTo(full?.width ?? 0, 0);
    await page.getByRole('button', { name: 'Décocher : a', exact: true }).click();
    await expect(page.getByText('1 / 2').first()).toBeVisible();
    await chooseChecklist(page, testInfo, 'Vide');
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('0 / 0');
    await expect(page.getByRole('progressbar')).toHaveCount(0);
  });
});
