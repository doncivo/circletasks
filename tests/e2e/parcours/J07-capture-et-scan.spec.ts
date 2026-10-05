import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { isPhone, openToday, rowOf } from '../helpers/today';

/**
 * Parcours clé 7 (PRD 8) : capture rapide et scan. Saisie en langage naturel (Q-02, Q-06) : l'aperçu annonce la date, l'heure et l'espace,
 * la tâche est créée avec un titre nettoyé. Puis scan d'une liste (Q-04) avec le faux moteur OCR de développement
 * (`__CT_FAKE_OCR__`, même crochet que Q-04.spec.ts), relecture, validation, tâches visibles dans Aujourd'hui.
 * La mini-fenêtre globale (Q-01) et la dictée (Q-03) sont des fonctions de bureau, couvertes par leurs specs et des essais manuels.
 */
const FIXTURE = resolve('tests/fixtures/ocr/liste-imprimee.png');
const LINES = [{ text: '- Appeler le plombier' }, { text: '- Acheter des ampoules' }, { text: '- Payer la cantine' }, { text: '- garage ?' }];

async function fakeOcr(page: Page): Promise<void> {
  await page.addInitScript((lines) => {
    (window as unknown as Record<string, unknown>)['__CT_FAKE_OCR__'] = { lines };
  }, LINES);
}

test('parcours 7 : saisie en langage naturel, puis scan d’une liste, relecture et validation', async ({ page }, testInfo) => {
  const phone = isPhone(testInfo);
  await fakeOcr(page);
  await openToday(page);

  // 1. Saisie en langage naturel : « aujourd'hui 10h #perso » (date explicite du jour, pour rester visible dans Aujourd'hui).
  const title = `Appeler le notaire ${phone ? 'iphone' : 'pc'}`;
  let field;
  if (phone) {
    await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
    field = page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByLabel('Titre');
  } else {
    field = page.getByLabel('Nouvelle tâche');
  }
  await field.fill(`${title} aujourd’hui 10h #perso`);
  const preview = page.getByRole('group', { name: 'Ce qui sera appliqué' });
  await expect(preview).toContainText('10:00');
  await expect(preview).toContainText('Perso');
  if (phone) await page.getByRole('dialog', { name: 'Nouvelle tâche' }).getByRole('button', { name: 'Enregistrer' }).click();
  else await field.press('Enter');
  // Tâche créée avec le titre nettoyé (ni date, ni heure, ni marque), à 10:00 dans Perso.
  const captured = rowOf(page, title);
  await expect(captured).toBeVisible();
  await expect(captured).toContainText('10:00');
  await expect(captured).not.toContainText('#perso');

  // 2. Scan d'une liste : image -> lecture -> relecture.
  await page.getByRole('button', { name: 'Scan tâches' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scan tâches' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Choisir une image').setInputFiles(FIXTURE);
  await expect(dialog.getByRole('heading', { name: 'Relecture' })).toBeVisible();
  await expect(dialog.getByText('4 lignes détectées')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Tâche 1' })).toHaveValue('Appeler le plombier');
  // La ligne douteuse « garage ? » est décochée et signalée ; on corrige une ligne avant de valider.
  await expect(dialog.getByText('Lecture incertaine, à vérifier')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Tâche 3' }).fill('Payer la cantine de septembre');
  await expect(dialog.getByRole('button', { name: 'Créer 3 tâches' })).toBeEnabled();

  // 3. Validation : les tâches cochées sont créées, annonce avec « Annuler », visibles dans Aujourd'hui.
  await dialog.getByRole('button', { name: 'Créer 3 tâches' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('3 tâches créées')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Annuler', exact: true })).toBeVisible();
  await expect(rowOf(page, 'Appeler le plombier')).toBeVisible();
  await expect(rowOf(page, 'Acheter des ampoules')).toBeVisible();
  await expect(rowOf(page, 'Payer la cantine de septembre')).toBeVisible();
  await expect(rowOf(page, 'garage')).toHaveCount(0);
  // La tâche saisie à la main reste présente.
  await expect(rowOf(page, title)).toBeVisible();
});
