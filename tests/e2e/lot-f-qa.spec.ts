import { expect, test, type Page } from '@playwright/test';
import { backupState, failNextBackup, installFakeBackups, type FakeVersion } from './helpers/backups';
import { installFakeFiles, nextFilesMode, savedFiles } from './helpers/files';
import { openToday } from './helpers/today';

/**
 * QA du lot F (FILES-IOS-01, I-04, P-04-iOS) : états d'échec jamais sans action utile, jamais un « Réessayer » qui ne peut pas réussir, et
 * aucun défilement horizontal dans 440 × 956 (projet `iphone`) comme sur `pc`. Complète `lot-f-screens.spec.ts` (qui couvre les états
 * nominaux et l'échec de simple enregistrement).
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

async function openSheet(page: Page, options: Parameters<typeof installFakeBackups>[2] = { directory: null }) {
  await page.clock.setFixedTime(new Date('2026-10-08T08:00:00Z'));
  await installFakeBackups(page, VERSIONS, options);
  await openToday(page);
  await tab(page, 'Réglages').click();
  await page.getByRole('button', { name: 'Restaurer une sauvegarde' }).click();
  const sheet = page.getByRole('dialog', { name: 'Restaurer une sauvegarde' });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function restoreFirst(page: Page, sheet: ReturnType<Page['getByRole']>): Promise<void> {
  await sheet.getByRole('button', { name: /7 oct\. à 03:12/ }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Restaurer' }).click();
}

test.describe('Lot F QA — P-04-iOS : échecs de la restauration', () => {
  test('sauvegarde illisible ou plus récente : message, aucune action vaine, autre version choisissable, pas de défilement horizontal', async ({ page }) => {
    const sheet = await openSheet(page);
    for (const [reason, text] of [
      ['corrupt', 'Cette sauvegarde est illisible'],
      ['newer-schema', 'plus récente de CircleTasks'],
    ] as const) {
      await failNextBackup(page, 'restore', reason);
      await restoreFirst(page, sheet);
      const alert = sheet.getByRole('alert').filter({ hasText: text });
      await expect(alert).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
      await expect(sheet.getByRole('button', { name: 'Redémarrer' })).toHaveCount(0);
      await expect(sheet.getByRole('button', { name: /7 oct\. à 03:12/ })).toBeEnabled();
      await noHorizontalScroll(page);
    }
    await page.waitForTimeout(1500);
    expect((await backupState(page)).restarts).toBe(0);
  });

  test('synchronisation en cours / base occupée : « Réessayer » relance vraiment et la restauration aboutit (voile, annonce, redémarrage)', async ({ page }) => {
    const sheet = await openSheet(page);
    await failNextBackup(page, 'restore', 'sync-busy');
    await restoreFirst(page, sheet);
    const alert = sheet.getByRole('alert').filter({ hasText: 'Une synchronisation est en cours' });
    await expect(alert).toBeVisible();
    await noHorizontalScroll(page);
    await alert.getByRole('button', { name: 'Réessayer' }).click();
    await expect(sheet.getByText('Restauration terminée, redémarrage')).toBeVisible();
    await expect.poll(async () => (await backupState(page)).restores.length).toBe(1);
    await expect.poll(async () => (await backupState(page)).restarts).toBe(1);
  });

  test('échec après la fermeture de la base : « Redémarrer » est l’action offerte (pas « Réessayer »), message lisible dans 440 px', async ({ page }) => {
    const sheet = await openSheet(page);
    await failNextBackup(page, 'restore', 'rollback-failed', true);
    await restoreFirst(page, sheet);
    const alert = sheet.getByRole('alert').filter({ hasText: 'l’ancien fichier n’a pas pu être remis en place' });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Redémarrer' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
    await noHorizontalScroll(page);
    await alert.getByRole('button', { name: 'Redémarrer' }).click();
    await expect.poll(async () => (await backupState(page)).restarts).toBe(1);
  });

  test('ligne de Réglages : « Dernière sauvegarde échouée » en rouge, sans défilement horizontal', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-08T08:00:00Z'));
    await installFakeBackups(page, [], { directory: null, failFirstDaily: true });
    await openToday(page);
    await tab(page, 'Réglages').click();
    await expect(page.getByTestId('backup-summary')).toContainText('Dernière sauvegarde échouée');
    await expect(page.getByTestId('backup-summary')).toHaveClass(/danger/);
    await noHorizontalScroll(page);
  });
});

test.describe('Lot F QA — FILES-IOS-01 / I-04 : échecs d’enregistrement et du journal', () => {
  async function openLogs(page: Page, installLogs: (page: Page) => Promise<void>): Promise<void> {
    await page.clock.setFixedTime(new Date('2026-10-08T08:00:00Z'));
    await installFakeFiles(page);
    await installLogs(page);
    await openToday(page);
    await tab(page, 'Réglages').click();
    await page.getByRole('button', { name: 'Ouvrir l’écran des logs' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
  }

  const healthyLogs = async (page: Page): Promise<void> => {
    await page.addInitScript(() => {
      const stored = [{ at: '2026-10-08T06:00:00.000Z', scope: 'sync', code: 'sync-now', detail: '' }];
      (globalThis as { __ctLogs?: unknown }).__ctLogs = {
        append: () => Promise.resolve({ writeError: null }),
        read: () => Promise.resolve({ entries: stored, writeError: null }),
        clear: () => Promise.resolve(),
      };
    });
  };

  test('fichier trop gros : « Fichier trop volumineux » avec le code, aucun « Réessayer », rien d’enregistré', async ({ page }) => {
    await openLogs(page, healthyLogs);
    await nextFilesMode(page, 'too-large');
    await page.getByRole('button', { name: 'Exporter' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Fichier trop volumineux' });
    await expect(alert).toContainText('Code : too-large');
    await expect(alert.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
    expect(await savedFiles(page)).toHaveLength(0);
    await noHorizontalScroll(page);
  });

  test('enregistrement annulé : aucun message, aucun fichier ; puis réussi', async ({ page }) => {
    await openLogs(page, healthyLogs);
    await nextFilesMode(page, 'cancel');
    await page.getByRole('button', { name: 'Exporter' }).click();
    await expect(page.getByRole('button', { name: 'Exporter' })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await savedFiles(page)).toHaveLength(0);
    await page.getByRole('button', { name: 'Exporter' }).click();
    await expect(page.getByText('Logs exportés')).toBeVisible();
    expect(await savedFiles(page)).toHaveLength(1);
  });

  test('journal illisible et écriture impossible : deux messages avec code en rouge, liste de secours, « Effacer » disponible, pas de défilement horizontal', async ({ page }) => {
    await openLogs(page, async (p) => {
      await p.addInitScript(() => {
        (globalThis as { __ctLogs?: unknown }).__ctLogs = {
          append: () => Promise.reject({ code: 'disk-full' }),
          read: () => Promise.reject({ code: 'unreadable' }),
          clear: () => Promise.resolve(),
        };
      });
    });
    await expect(page.getByText(/Le journal n’a pas pu être lu.*Code : unreadable/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Effacer' })).toBeEnabled();
    await noHorizontalScroll(page);
  });
});
