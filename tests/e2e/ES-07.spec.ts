import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { isPhone } from './helpers/today';

/**
 * ES-07 — Je définis des plages silencieuses par espace.
 *
 * Couverture : Réglages › RAPPELS : « Silence Pro » (19:00 – 08:00, week-end) et « Silence Perso » (Aucune) par défaut ; éditeur de
 * plages (jours L à D, début et fin en 24 h, « Toute la journée ») : ajout, modification, suppression, enregistrement et résumé mis à
 * jour ; refus d'un début égal à la fin ; mention « Envoyé par l'iPhone » sur PC seulement. La règle de décalage des rappels (mardi
 * 20:00 → mercredi 08:00…) et la migration des plages de Pro sont testées en Vitest : aucune notification n'est émise à l'ordre 1.
 * Exécuté sur `pc` et `iphone`.
 */
test.describe('ES-07 — plages silencieuses par espace', () => {
  const row = (page: Page, space: 'Pro' | 'Perso') => page.getByRole('button', { name: new RegExp(`^Silence ${space} :`) });

  async function openSettings(page: Page): Promise<void> {
    await openApp(page);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByText('RAPPELS', { exact: true })).toBeVisible();
  }

  test('lignes « Silence Pro » et « Silence Perso » par défaut (critères 1, 2)', async ({ page }) => {
    await openSettings(page);
    await expect(row(page, 'Pro')).toContainText('19:00 – 08:00, week-end');
    await expect(row(page, 'Perso')).toContainText('Aucune');
  });

  test('ajoute une plage à Perso, enregistre : le résumé de la ligne suit (critère 3)', async ({ page }, testInfo) => {
    await openSettings(page);
    await row(page, 'Perso').click();
    await expect(page.getByRole('heading', { name: /^Silence\s*Perso$/ })).toBeVisible();
    await expect(page.getByText('Aucune plage : les rappels de cet espace ne sont jamais décalés.')).toBeVisible();
    // Mention « envoyé par l'iPhone » : PC seulement (critère 9).
    await expect(page.getByText('Les rappels sont envoyés par l’iPhone ; le PC n’en émet aucun.')).toBeVisible({ visible: !isPhone(testInfo) });
    await page.getByRole('button', { name: 'Ajouter une plage' }).click();
    const range = page.getByRole('region', { name: 'Plage 1' });
    await range.getByLabel('Début de la plage 1 (HH:MM)').fill('12:00');
    await range.getByLabel('Fin de la plage 1 (HH:MM)').fill('14:00');
    await range.getByRole('checkbox', { name: 'Mardi' }).click();
    await range.getByRole('checkbox', { name: 'Mercredi' }).click();
    await range.getByRole('checkbox', { name: 'Jeudi' }).click();
    await range.getByRole('checkbox', { name: 'Vendredi' }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page, 'Perso')).toContainText('lun. 12:00 – 14:00');
    // Rouvrir : la plage est là, modifiable puis supprimable.
    await row(page, 'Perso').click();
    await expect(page.getByRole('region', { name: 'Plage 1' }).getByLabel('Début de la plage 1 (HH:MM)')).toHaveValue('12:00');
    await page.getByRole('button', { name: 'Supprimer la plage 1' }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page, 'Perso')).toContainText('Aucune');
  });

  test('« Toute la journée » et plusieurs plages sur Pro ; début = fin refusé (critères 3, 4)', async ({ page }) => {
    await openSettings(page);
    await row(page, 'Pro').click();
    await expect(page.getByRole('region', { name: 'Plage 2' }).getByRole('switch', { name: 'Toute la journée, plage 2' })).toHaveAttribute('aria-checked', 'true');
    const first = page.getByRole('region', { name: 'Plage 1' });
    await first.getByLabel('Fin de la plage 1 (HH:MM)').fill('19:00');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('alert')).toHaveText('Plage 1 : le début et la fin doivent différer, ou cochez « Toute la journée ».');
    await first.getByLabel('Fin de la plage 1 (HH:MM)').fill('07:30');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(row(page, 'Pro')).toContainText('19:00 – 07:30, week-end');
  });
});
