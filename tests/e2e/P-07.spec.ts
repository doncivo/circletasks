import { expect, test, type Page } from '@playwright/test';
import { failNextPick, installFakeFiles, onlySaved, savedFiles, setPick, textOf } from './helpers/files';
import { listTitles, openToday } from './helpers/today';

/**
 * P-07 — J'importe mes tâches existantes. Date figée au lun. 5 oct. 2026, 10:00 (Paris). Le service de fichiers est un faux (la boîte « Ouvrir »
 * système n'existe pas dans le navigateur) : il rend le texte du CSV choisi et garde en mémoire ce qui serait enregistré (modèle, rapport).
 * Lecture du fichier par Rust (2 Mo, disque local) : `cargo test --test desktop` (tests/desktop/import.rs). Exécuté sur `pc` et `iphone`.
 */
const HEADER = 'titre;date;heure;espace;projet;note';
const MIXED = [
  HEADER,
  'Appeler Paul;2026-10-06;10:00;Perso;;à rappeler',
  'Rapport;07/10/2026;;Pro;Inconnu;',
  ';2026-10-06;;;;',
  'Soirée;31/02/2026;;;;',
  'Heure seule;;09:00;;;',
  'Ailleurs;;;Famille;;',
].join('\n');

const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function openImport(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-05T08:00:00Z'));
  await installFakeFiles(page);
  await openToday(page);
  await tab(page, 'Réglages').click();
  await page.getByRole('button', { name: 'Importer des tâches depuis un fichier CSV' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Importer des tâches' })).toBeVisible();
}

async function choose(page: Page, text: string, name = 'taches.csv'): Promise<void> {
  await setPick(page, { name, text });
  await page.getByRole('button', { name: /^Choisir (un|un autre) fichier$/ }).click();
}

test.describe('P-07 — import CSV', () => {
  test('critère 1 : la ligne de Réglages ouvre l’écran avec les colonnes et le modèle téléchargeable', async ({ page }) => {
    await openImport(page);
    await expect(page.getByText('titre;date;heure;espace;projet;note')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choisir un fichier' })).toBeVisible();
    await page.getByRole('button', { name: 'Télécharger un modèle' }).click();
    await expect(page.getByText('Modèle enregistré')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toBe('circletasks-modele-import.csv');
    expect(textOf(file)).toContain('titre;date;heure;espace;projet;note\r\nAppeler Paul;2026-10-06;10:00;Pro;;\r\n');
  });

  test('critères 3 à 5 : compteurs, tableau avec en-têtes, rejets avec numéro de ligne et motif, avertissements', async ({ page }) => {
    await openImport(page);
    await choose(page, MIXED);
    await expect(page.getByRole('status').filter({ hasText: '2 tâches à importer · 4 lignes rejetées · 1 avertissement' })).toBeVisible();
    const table = page.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText(['Titre', 'Date', 'Heure', 'Espace', 'Projet']);
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByRole('row').nth(1)).toContainText('Appeler Paul');
    await expect(table.getByRole('row').nth(1)).toContainText('10:00');
    await expect(table.getByRole('row').nth(1)).toContainText('Perso');
    await expect(page.getByText('Ligne 4 : titre vide')).toBeVisible();
    await expect(page.getByText('Ligne 5 : date invalide « 31/02/2026 »')).toBeVisible();
    await expect(page.getByText('Ligne 6 : heure sans date « 09:00 »')).toBeVisible();
    await expect(page.getByText('Ligne 7 : espace inconnu « Famille »')).toBeVisible();
    await expect(page.getByText('Ligne 3 : projet inconnu « Inconnu », tâche importée sans projet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Importer 2 tâches' })).toBeEnabled();
  });

  test('critère 6 : le rapport des lignes rejetées est proposé à l’enregistrement', async ({ page }) => {
    await openImport(page);
    await choose(page, MIXED);
    await page.getByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }).click();
    await expect(page.getByText('Rapport enregistré')).toBeVisible();
    const report = textOf(await onlySaved(page));
    expect(report).toContain('ligne;motif;titre;date;heure;espace;projet;note');
    expect(report).toContain('5;date invalide « 31/02/2026 »;Soirée;31/02/2026;;;;');
  });

  test('critères 7 et 8 : import en une fois, message, « Voir dans Aujourd’hui » et liste du jour à jour', async ({ page }) => {
    await openImport(page);
    await choose(page, `${HEADER}\nPremière;;;;;\nDeuxième;;;Perso;;\nTroisième;2026-10-09;;;;`);
    await page.getByRole('button', { name: 'Importer 3 tâches' }).click();
    await expect(page.getByRole('status').filter({ hasText: '3 tâches importées' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Voir dans Aujourd’hui' }).click();
    await expect.poll(() => listTitles(page)).toEqual(['Première', 'Deuxième']);
  });

  test('critère 7 : « Annuler » retire toutes les tâches importées d’un coup', async ({ page }) => {
    await openImport(page);
    await choose(page, `${HEADER}\nA;;;;;\nB;;;;;\nC;;;;;`);
    await page.getByRole('button', { name: 'Importer 3 tâches' }).click();
    await expect(page.getByText('3 tâches importées').first()).toBeVisible();
    await page.getByRole('button', { name: 'Annuler', exact: true }).click();
    await page.getByRole('button', { name: 'Voir dans Aujourd’hui' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => listTitles(page)).toEqual([]);
  });

  test('critère 4 : « Un jour » pour les tâches sans date', async ({ page }) => {
    await openImport(page);
    await choose(page, `${HEADER}\nÀ plus tard;;;;;`);
    await page.getByRole('radio', { name: 'Un jour' }).click();
    await expect(page.getByRole('table').getByRole('cell', { name: 'Un jour' })).toBeVisible();
    await page.getByRole('button', { name: 'Importer 1 tâche' }).click();
    await expect(page.getByText('1 tâche importée').first()).toBeVisible();
    await page.getByRole('button', { name: 'Voir dans Aujourd’hui' }).click();
    await expect.poll(() => listTitles(page)).toEqual([]);
  });

  test('critère 9 : un fichier produit par l’export de H-03 s’importe sans erreur et redonne les textes d’origine', async ({ page }) => {
    await openImport(page);
    const exported = [
      'titre;date;heure;espace;projet;note;statut;termine_le;objectif;repetition',
      "'=SOMME(A1:A3);2026-10-05;;Pro;;\"'+33 6 12\nsuite\";à faire;;;",
      "'-5 degrés;2026-10-05;09:30;Perso;;;fait;2026-10-05;;",
    ].join('\r\n');
    await choose(page, `${String.fromCharCode(0xfeff)}${exported}\r\n`);
    await expect(page.getByRole('status').filter({ hasText: '2 tâches à importer · 0 ligne rejetée · 0 avertissement' })).toBeVisible();
    await expect(page.getByText('Colonnes ignorées : statut, termine_le, objectif, repetition')).toBeVisible();
    await page.getByRole('button', { name: 'Importer 2 tâches' }).click();
    await page.getByRole('button', { name: 'Voir dans Aujourd’hui' }).click();
    // Critère 11 : « = » et « - » restent du texte, sans l’apostrophe de l’export (la tâche à 09:30 passe avant celle sans heure).
    await expect.poll(() => listTitles(page)).toEqual(['-5 degrés', '=SOMME(A1:A3)']);
  });

  test('critère 10 : importer deux fois le même fichier crée les doublons et l’aperçu le signale', async ({ page }) => {
    await openImport(page);
    const text = `${HEADER}\nA;2026-10-06;;;;\nB;2026-10-06;;;;`;
    await choose(page, text);
    await page.getByRole('button', { name: 'Importer 2 tâches' }).click();
    await expect(page.getByText('2 tâches importées').first()).toBeVisible();
    await page.getByRole('button', { name: 'Importer un autre fichier' }).click();
    await choose(page, text);
    await expect(page.getByText('2 tâches existent déjà (même titre et même date) : elles seront créées en double.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Importer 2 tâches' })).toBeEnabled();
  });

  test('critère 12 : plus de 200 lignes sont écrites par lots, toutes importées', async ({ page }) => {
    await openImport(page);
    const rows = Array.from({ length: 450 }, (_, i) => `Tâche ${String(i + 1)};2026-10-06;;;;`);
    await choose(page, `${HEADER}\n${rows.join('\n')}`);
    await expect(page.getByRole('status').filter({ hasText: '450 tâches à importer' })).toBeVisible();
    await expect(page.getByText('… et 430 autres tâches')).toBeVisible();
    await page.getByRole('button', { name: 'Importer 450 tâches' }).click();
    await expect(page.getByText('450 tâches importées').first()).toBeVisible();
  });

  test('critère 2 : colonne titre absente, fichier trop gros, fichier vide', async ({ page }) => {
    await openImport(page);
    await choose(page, 'date;heure\n2026-10-06;10:00');
    await expect(page.getByRole('alert')).toHaveText('La colonne « titre » est absente : rien ne peut être importé.');
    await failNextPick(page, 'too-large');
    await page.getByRole('button', { name: 'Choisir un fichier' }).click();
    await expect(page.getByRole('alert')).toHaveText('Le fichier dépasse 2 Mo : réduisez-le puis réessayez.');
    await choose(page, '');
    await expect(page.getByRole('alert')).toHaveText('Le fichier est vide.');
    expect(await savedFiles(page)).toEqual([]);
  });

  test('annuler la boîte de choix ne change rien', async ({ page }) => {
    await openImport(page);
    await setPick(page, null);
    await page.getByRole('button', { name: 'Choisir un fichier' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choisir un fichier' })).toBeEnabled();
  });
});
