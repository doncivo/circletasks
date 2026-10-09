import { expect, test, type Page } from '@playwright/test';
import { installFakeBackups, type FakeVersion } from './helpers/backups';
import { installFakeFiles, nextFilesMode, setPick } from './helpers/files';
import { openReport } from './helpers/stats';
import { openToday } from './helpers/today';

/**
 * Lot F (FILES-IOS-01, I-04, P-04-iOS), consigne d'audit : chaque écran du lot tient dans 440 × 956 (projet `iphone`) sans défilement
 * horizontal, y compris dans ses états d'échec, et chaque échec offre une action utile. Exécuté aussi sur `pc` (même contrainte, plus large).
 */
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>('body *')].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(element).position !== 'fixed');
    return { scroll: doc.scrollWidth - doc.clientWidth, wide: wide.slice(0, 3).map((element) => element.className || element.tagName) };
  });
  expect(overflow.scroll, JSON.stringify(overflow.wide)).toBeLessThanOrEqual(0);
}

const VERSIONS: FakeVersion[] = [{ name: 'circletasks-daily-20261007.db', kind: 'daily', stamp: '20261007', size: 40_960, at: '2026-10-07T03:12:00', tasks: 4 }];

test.describe('Lot F — écrans sans défilement horizontal, échecs avec une action utile', () => {
  test('Logs : liste, échec d’export avec code et « Réessayer »', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-08T08:00:00Z'));
    await installFakeFiles(page);
    await openToday(page);
    await tab(page, 'Réglages').click();
    await page.getByRole('button', { name: 'Ouvrir l’écran des logs' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
    await noHorizontalScroll(page);
    await nextFilesMode(page, 'fail');
    await page.getByRole('button', { name: 'Exporter' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'L’export n’a pas abouti.' });
    await expect(alert).toContainText('Code : write-failed');
    await noHorizontalScroll(page);
    await alert.getByRole('button', { name: 'Réessayer' }).click();
    await expect(page.getByText('Logs exportés')).toBeVisible();
  });

  test('Import CSV : aperçu et échec d’enregistrement du rapport', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-05T08:00:00Z'));
    await installFakeFiles(page);
    await openToday(page);
    await tab(page, 'Réglages').click();
    await page.getByRole('button', { name: 'Importer des tâches depuis un fichier CSV' }).click();
    await noHorizontalScroll(page);
    await setPick(page, { name: 'taches.csv', text: 'titre;date;heure;espace;projet;note\nAppeler Paul;2026-10-06;10:00;Perso;;\nSoirée très longue avec un titre qui ne tient pas sur une ligne;31/02/2026;;;;' });
    await page.getByRole('button', { name: 'Choisir un fichier' }).click();
    await nextFilesMode(page, 'fail');
    await page.getByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }).click();
    await expect(page.getByRole('alert')).toContainText('Code : write-failed');
    await noHorizontalScroll(page);
  });

  test('Export H-03 : fenêtre d’export et échec', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T08:00:00Z'));
    await installFakeFiles(page);
    await openToday(page);
    await openReport(page, 'septembre');
    await page.getByRole('button', { name: 'Exporter', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Exporter l’historique' });
    await expect(dialog).toBeVisible();
    await nextFilesMode(page, 'fail');
    await dialog.getByRole('button', { name: 'Exporter', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Code : write-failed');
    await expect(dialog.getByRole('alert').getByRole('button', { name: 'Réessayer' })).toBeVisible();
    await noHorizontalScroll(page);
  });

  test('Sauvegardes (P-04-iOS) : feuille, voile de la restauration et annonce du redémarrage', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-08T08:00:00Z'));
    await installFakeBackups(page, VERSIONS, { directory: null });
    await openToday(page);
    await tab(page, 'Réglages').click();
    await page.getByRole('button', { name: 'Restaurer une sauvegarde' }).click();
    const sheet = page.getByRole('dialog', { name: 'Restaurer une sauvegarde' });
    await expect(sheet).toBeVisible();
    await noHorizontalScroll(page);
    await sheet.getByRole('button', { name: /7 oct\. à 03:12/ }).click();
    await expect(page.getByRole('alertdialog').getByRole('button', { name: 'Annuler' })).toBeFocused();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restaurer' }).click();
    await expect(sheet.getByText('Restauration terminée, redémarrage')).toBeVisible();
    await expect(page.locator('.ct-backup__veil')).toHaveCount(1);
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await noHorizontalScroll(page);
  });
});
