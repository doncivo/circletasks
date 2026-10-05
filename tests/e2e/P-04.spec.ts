import { expect, test, type Page } from '@playwright/test';
import { backupState, failNextBackup, installFakeBackups, type FakeVersion } from './helpers/backups';
import { isPhone, openToday } from './helpers/today';

/**
 * P-04 — Je sauvegarde et restaure mes données. Date figée au lun. 5 oct. 2026, 10:00 (Paris). Le service de sauvegarde est un faux gardé dans
 * la page (le navigateur n'a pas de fichier à remplacer) : sauvegarde du jour à l'ouverture, ligne de Réglages, liste des versions,
 * confirmation, restauration annoncée puis redémarrage, refus. Remplacement atomique, purge 14 / 5 / 3 et échec simulé : `cargo test`
 * (src-tauri/tests/desktop/restore.rs). Exécuté sur `pc` et `iphone`.
 */
const OLDER: FakeVersion[] = [
  { name: 'circletasks-daily-20261003.db', kind: 'daily', stamp: '20261003', size: 2_411_725, at: '2026-10-03T03:12:00', tasks: 48 },
  { name: 'circletasks-daily-20261004.db', kind: 'daily', stamp: '20261004', size: 40_960, at: '2026-10-04T21:40:00', tasks: 1 },
  { name: 'circletasks-pre-migration-v0013-to-v0014-20261001T080000Z.db', kind: 'pre-migration', stamp: '20261001T080000Z', size: 30_720, at: '2026-10-01T10:00:00', tasks: null },
];

const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function openSettings(page: Page, versions: FakeVersion[] = OLDER, options: Parameters<typeof installFakeBackups>[2] = {}): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-05T08:00:00Z'));
  await installFakeBackups(page, versions, options);
  await openToday(page);
  await tab(page, 'Réglages').click();
  await expect(page.getByRole('heading', { name: 'Réglages' })).toBeVisible();
}

async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Restaurer une sauvegarde' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restaurer une sauvegarde' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('P-04 — sauvegarde et restauration', () => {
  test('critères 1 et 3 : une sauvegarde du jour à l’ouverture, et la ligne de Réglages l’affiche', async ({ page }) => {
    await openSettings(page);
    await expect(page.getByText('DONNÉES ET SÉCURITÉ')).toBeVisible();
    await expect(page.getByText('Sauvegarde automatique')).toBeVisible();
    await expect(page.getByTestId('backup-summary')).toHaveText('Aujourd’hui 10:00 · 3 versions');
    const state = await backupState(page);
    expect(state.dailyCalls).toEqual([{ day: '20261005', replace: false }]);
  });

  test('critère 1 : la sauvegarde du jour existante n’est pas recréée', async ({ page }) => {
    await openSettings(page, [...OLDER, { name: 'circletasks-daily-20261005.db', kind: 'daily', stamp: '20261005', size: 1000, at: '2026-10-05T03:12:00', tasks: 3 }]);
    await expect(page.getByTestId('backup-summary')).toHaveText('Aujourd’hui 03:12 · 3 versions');
    expect((await backupState(page)).dailyCalls).toEqual([]);
  });

  test('critère 3 : « Aucune sauvegarde » puis erreur en rouge quand la sauvegarde échoue', async ({ page }) => {
    await openSettings(page, [], { failFirstDaily: true });
    const summary = page.getByTestId('backup-summary');
    await expect(summary).toHaveText('Dernière sauvegarde échouée');
    await expect(summary).toHaveClass(/danger/);
  });

  test('critère 4 : la feuille liste les versions, plus récentes d’abord, avec « Avant mise à jour » et l’emplacement', async ({ page }, testInfo) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    if (isPhone(testInfo)) await expect(dialog).toHaveClass(/ct-sheet/);
    const rows = dialog.getByRole('list', { name: 'Versions sauvegardées' }).getByRole('button');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('5 oct. à 10:00');
    await expect(rows.nth(1)).toContainText('4 oct. à 21:40');
    await expect(rows.nth(1)).toContainText('40 Ko · 1 tâche');
    await expect(rows.nth(2)).toContainText('3 oct. à 03:12');
    await expect(rows.nth(2)).toContainText('2,3 Mo · 48 tâches');
    await expect(rows.nth(3)).toContainText('Avant mise à jour');
    await expect(dialog.getByText(/Dossier des sauvegardes : C:\\Users\\Ali/)).toBeVisible();
    await expect(dialog.getByText(/ne sont jamais synchronisées/)).toBeVisible();
  });

  test('critère 4 : « Sauvegarder maintenant » remplace la version du jour', async ({ page }) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('button', { name: 'Sauvegarder maintenant' }).click();
    await expect(dialog.getByText('Sauvegarde du jour mise à jour')).toBeVisible();
    const state = await backupState(page);
    expect(state.dailyCalls.at(-1)).toEqual({ day: '20261005', replace: true });
    await expect(dialog.getByRole('list', { name: 'Versions sauvegardées' }).getByRole('button')).toHaveCount(4);
  });

  test('critère 9 : « Afficher dans le dossier »', async ({ page }) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('button', { name: 'Afficher dans le dossier' }).click();
    await expect.poll(async () => (await backupState(page)).revealed).toBe(1);
  });

  test('critères 5 et 12 : confirmation avec le focus sur « Annuler » ; annuler ne restaure rien', async ({ page }) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('button', { name: /3 oct\. à 03:12/ }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Restaurer cette version ?' });
    await expect(confirm.getByText('Les données actuelles seront remplacées par celles du 3 oct. à 03:12. Une copie de l’état actuel est faite avant.')).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Annuler' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Annuler' }).click();
    await expect(confirm).not.toBeVisible();
    expect((await backupState(page)).restores).toEqual([]);
  });

  test('critères 5, 6 et 12 : un clic de confirmation restaure, annonce le redémarrage puis relance l’app', async ({ page }) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    await dialog.getByRole('button', { name: /3 oct\. à 03:12/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restaurer' }).click();
    await expect(dialog.getByText('Restauration terminée, redémarrage')).toBeVisible();
    const state = await backupState(page);
    expect(state.restores).toHaveLength(1);
    expect(state.restores[0]?.name).toBe('circletasks-daily-20261003.db');
    expect(state.restores[0]?.stamp).toMatch(/^20261005T\d{6}Z$/);
    await expect.poll(async () => (await backupState(page)).restarts, { timeout: 5000 }).toBe(1);
  });

  test('critère 7 : une version plus récente que l’app est refusée avec un message, sans redémarrage', async ({ page }) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    await failNextBackup(page, 'restore', 'newer-schema');
    await dialog.getByRole('button', { name: /4 oct\. à 21:40/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restaurer' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'plus récente de CircleTasks' })).toBeVisible();
    await page.waitForTimeout(1500);
    expect((await backupState(page)).restarts).toBe(0);
  });

  test('critère 8 : un échec après la fermeture de la base propose de redémarrer', async ({ page }) => {
    await openSettings(page);
    const dialog = await openSheet(page);
    await failNextBackup(page, 'restore', 'io', true);
    await dialog.getByRole('button', { name: /4 oct\. à 21:40/ }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restaurer' }).click();
    await expect(dialog.getByText('Redémarrez CircleTasks pour retrouver vos données actuelles', { exact: false })).toBeVisible();
    await dialog.getByRole('button', { name: 'Redémarrer' }).click();
    await expect.poll(async () => (await backupState(page)).restarts).toBe(1);
  });

  test('plateforme sans sauvegarde (iPhone installé) : la ligne n’est pas affichée', async ({ page }) => {
    await openSettings(page, [], { available: false });
    await expect(page.getByText('DONNÉES ET SÉCURITÉ')).toBeVisible();
    await expect(page.getByText('Sauvegarde automatique')).toHaveCount(0);
  });
});
