import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { chooseChecklist, insertChecklists, itemTexts, reopenChecklists } from './helpers/checklists';
import { isPhone } from './helpers/today';

/**
 * C-04 — Je réutilise une checklist modèle.
 *
 * Couverture : « Dupliquer et réinitialiser » (pied du détail sur PC, feuille « Modifier la checklist » sur iPhone) crée
 * « <titre> (copie) » décochée, sans date, ouverte ; l'original reste intact ; interrupteur « Modèle réutilisable » et mention
 * « Perso · modèle réutilisable » ; message « Checklist dupliquée » annulable. Exécuté sur `pc` et `iphone`.
 */
const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;
const TEXTS = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', 'Passeport', 'Chargeur', 'Billets d’avion'];

async function duplicate(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.getByRole('button', { name: 'Modifier la checklist' }).click();
    await page.getByRole('form', { name: 'Modifier la checklist' }).getByRole('button', { name: 'Dupliquer et réinitialiser' }).click();
  } else {
    await page.getByRole('button', { name: 'Dupliquer et réinitialiser' }).click();
  }
}

test.describe('C-04 — checklist modèle', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await insertChecklists(page, [{ title: 'Valise voyage', space: 'perso', icon: 'lucide:briefcase', date: '2026-10-09', template: true, items: VALISE }]);
    await reopenChecklists(page);
    await expect(page.getByText('3 / 6').first()).toBeVisible();
  });

  test('crée la copie décochée, sans date, ouverte ; l’original est inchangé (critères 1, 2)', async ({ page }, testInfo) => {
    await duplicate(page, isPhone(testInfo));
    await expect(page.getByRole('heading', { name: 'Valise voyage (copie)', exact: true })).toBeVisible();
    await expect.poll(() => itemTexts(page)).toEqual(TEXTS);
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('0 / 6');
    await expect(page.getByText(/Prévue le/)).toHaveCount(0);
    await expect(page.getByText(/modèle réutilisable/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Décocher : / })).toHaveCount(0);

    await chooseChecklist(page, testInfo, 'Valise voyage');
    await expect(page.locator('.ct-checklist-progress__count')).toHaveText('3 / 6');
    await expect(page.getByText(/Prévue le/)).toBeVisible();
    await expect(page.getByText('Perso · modèle réutilisable')).toBeVisible();
  });

  test('« Annuler » supprime la copie (critère 5)', async ({ page }, testInfo) => {
    await duplicate(page, isPhone(testInfo));
    await expect(page.getByText('Checklist dupliquée')).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Valise voyage', exact: true })).toBeVisible();
    if (isPhone(testInfo)) await expect(page.getByRole('combobox', { name: 'Choisir une checklist' }).locator('option')).toHaveCount(1);
    else await expect(page.locator('.ct-checklist-list__name')).toHaveText(['Valise voyage']);
  });

  test('l’interrupteur « Modèle réutilisable » et la mention (critère 3)', async ({ page }, testInfo) => {
    await page.getByRole('button', { name: 'Modifier la checklist' }).click();
    const form = page.getByRole('form', { name: 'Modifier la checklist' });
    const toggle = form.getByRole('switch', { name: 'Modèle réutilisable' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByText(/modèle réutilisable/)).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Perso · modèle réutilisable')).toBeVisible();
    if (isPhone(testInfo)) await expect(form.getByRole('button', { name: 'Dupliquer et réinitialiser' })).toBeVisible();
  });
});
