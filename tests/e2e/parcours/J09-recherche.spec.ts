import { expect, test } from '@playwright/test';
import { openApp } from '../helpers/app';
import { addIsoDays, browserToday } from '../helpers/schedule';
import { chipOf, chooseChip, insertSearchTasks, openSearch, resultRows, searchDialog, typeSearch } from '../helpers/search';
import { detailOf } from '../helpers/spaces';

/**
 * Parcours clé 9 (PRD 8) : rechercher une tâche par un mot de sa note, filtrer par espace, ouvrir le détail (RC-01, RC-02, RC-03).
 * Pc : Ctrl+K, flèches et Entrée ; iPhone : loupe d'Aujourd'hui et toucher.
 */
test('parcours 9 : chercher un mot de la note, filtrer par espace Pro, ouvrir le détail', async ({ page }, testInfo) => {
  await openApp(page);
  const today = await browserToday(page);
  await insertSearchTasks(page, [
    { title: 'Appeler le fournisseur', note: 'contester la facture d’électricité', space: 'perso', date: addIsoDays(today, 1) },
    { title: 'Relancer le client', note: 'rappeler la facture de septembre', space: 'pro', date: addIsoDays(today, 2) },
    { title: 'Acheter du pain', space: 'perso', date: today },
  ]);

  // 1. Recherche par un mot de la note : les deux tâches des deux espaces, la note citée.
  await openSearch(page, testInfo);
  await typeSearch(page, 'facture');
  await expect(searchDialog(page).getByText('2 résultats')).toBeVisible();
  await expect(resultRows(page).filter({ hasText: 'Appeler le fournisseur' })).toContainText('Note : « contester la facture d’électricité »');

  // 2. Filtre Pro : seule la tâche Pro reste.
  await chooseChip(page, 'Filtre Espace : Tout', 'Pro');
  await expect(chipOf(page, 'Filtre Espace : Pro')).toBeVisible();
  await expect(searchDialog(page).getByText('1 résultat', { exact: true })).toBeVisible();
  await expect(resultRows(page)).toHaveCount(1);
  await expect(resultRows(page).first()).toContainText('Relancer le client');

  // 3. Ouvrir : Entrée sur PC, toucher sur iPhone ; la fiche détail s'ouvre.
  if (testInfo.project.name === 'iphone') await resultRows(page).first().click();
  else {
    await page.keyboard.press('Enter');
  }
  await expect(searchDialog(page)).toHaveCount(0);
  await expect(detailOf(page)).toBeVisible();
  await expect(detailOf(page)).toContainText('Relancer le client');
  await expect(detailOf(page)).toContainText('rappeler la facture de septembre');
});
