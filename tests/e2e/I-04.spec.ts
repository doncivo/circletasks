import { expect, test, type Page } from '@playwright/test';
import { installFakeFiles, nextFilesMode, onlySaved, textOf } from './helpers/files';
import { openToday } from './helpers/today';

/**
 * I-04 — Je consulte et exporte les logs (critère 11), projets `iphone` et `pc`. Le journal persistant est un faux (`globalThis.__ctLogs`,
 * transport en mémoire rempli de 600 entrées) ; l'export passe par le faux service de fichiers. Rotation, liens et lecture tolérante :
 * `cargo test` (tests/desktop/applog.rs).
 */
const SENTINEL = 'TITRE-SECRET-123';

async function installFakeLogs(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scopes = ['sync', 'notifications', 'backup-daily', 'sync-rust', 'export-save'];
    const stored = Array.from({ length: 600 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 8, 6, 0, i % 60) + i * 60_000).toISOString(),
      scope: scopes[i % scopes.length] ?? 'sync',
      code: `code-${String(i)}`,
      detail: i % 7 === 0 ? 'replan open: unreadable (3)' : '',
    }));
    (globalThis as { __ctLogs?: unknown }).__ctLogs = {
      append: (entries: unknown[]) => {
        stored.push(...(entries as typeof stored));
        return Promise.resolve({ writeError: null });
      },
      read: (max: number) => Promise.resolve({ entries: stored.slice(-max), writeError: null }),
      clear: () => {
        stored.splice(0, stored.length, { at: new Date().toISOString(), scope: 'logs', code: 'logs-cleared', detail: '' });
        return Promise.resolve();
      },
    };
  });
}

async function openLogs(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-08T08:00:00Z'));
  await installFakeFiles(page);
  await installFakeLogs(page);
  await openToday(page);
  await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
  await page.getByRole('button', { name: 'Ouvrir l’écran des logs' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Logs' })).toBeVisible();
}

test.describe('I-04 — écran Logs', () => {
  test('critère 11 : 500 entrées au plus, défilement, filtres, export lu (aucune sentinelle), annulation sans message', async ({ page }) => {
    await openLogs(page);
    const log = page.getByRole('log');
    await expect(log.getByRole('listitem')).toHaveCount(500);
    // Les plus récentes d'abord ; l'app ajoute aussi ses propres entrées de session (synchro au démarrage) au-dessus du faux.
    const items = log.getByRole('listitem');
    await expect(items.filter({ hasText: 'code-599' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'code-99 ' })).toHaveCount(0);
    await items.last().scrollIntoViewIfNeeded();
    await expect(items.last()).toBeInViewport();
    await page.getByRole('button', { name: 'Synchro', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Synchro', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(items.filter({ hasText: 'backup-daily' })).toHaveCount(0);
    await expect(items.filter({ hasText: 'sync-rust' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Erreurs', exact: true }).click();
    await expect(items.filter({ hasText: 'sync-rust' })).toHaveCount(0);
    await expect(items.filter({ hasText: 'export-save' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Tout', exact: true }).click();

    await nextFilesMode(page, 'cancel');
    await page.getByRole('button', { name: 'Exporter' }).click();
    await expect(page.getByRole('button', { name: 'Exporter' })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);

    await page.getByRole('button', { name: 'Exporter' }).click();
    await expect(page.getByText('Logs exportés')).toBeVisible();
    const file = await onlySaved(page);
    expect(file.name).toMatch(/^circletasks-logs-\d{8}-\d{4}\.txt$/);
    expect(file.mime).toBe('text/plain');
    const text = textOf(file);
    expect(text).toContain('Ce fichier ne contient ni titres ni notes.');
    expect(text).toContain('Entrées : 500');
    expect(text).toContain(' sync-rust code-598');
    expect(text).not.toContain(SENTINEL);
  });

  test('critère 8 : « Effacer » avec confirmation (Annuler par défaut), puis logs-cleared seule entrée', async ({ page }) => {
    await openLogs(page);
    await page.getByRole('button', { name: 'Effacer' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Effacer' }).click();
    await expect(page.getByRole('log').getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('log').getByRole('listitem')).toContainText('logs logs-cleared');
  });
});
