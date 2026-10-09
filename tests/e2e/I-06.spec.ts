import { expect, test, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from './helpers/app';

/**
 * I-06 — Je mets à jour l'app iPhone depuis SideStore (critère 17).
 *
 * Projet `iphone`, prises de développement seulement : `__ctAppVersion` (version 0.3.0 simulée), `__ctDbOpen` (base SQLite Wasm préremplie
 * à la version de schéma N = toutes les migrations sauf la dernière, avec une tâche du jour ; l'app applique la dernière migration au
 * démarrage), `__ctMigrationBackup` et `__ctStartupRecovery` (faux port de sauvegarde et faux service de restauration). Trois cas :
 * mise à jour réussie, migration en échec, base plus récente que l'app.
 */

type Mode = 'update' | 'fail' | 'newer';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TITLE = 'Tâche créée avant la mise à jour';

async function installAtN(page: Page, mode: Mode): Promise<void> {
  await page.addInitScript(
    ({ mode, title }) => {
      const g = globalThis as Record<string, unknown>;
      g['__ctAppVersion'] = '0.3.0';
      g['__ctDbOpen'] = async () => {
        // Modules du serveur de développement (même instance que l'app : mêmes URL).
        const load = (path: string): Promise<unknown> => import(/* @vite-ignore */ path);
        const drivers = (await load('/src/db/drivers/sqliteWasm.ts')) as { openSqliteWasmDriver: () => Promise<Record<string, unknown>> };
        const migrator = (await load('/src/db/migrator.ts')) as { migrate: (db: unknown, list: unknown[]) => Promise<unknown> };
        const { migrations } = (await load('/src/db/migrations/index.ts')) as { migrations: unknown[] };
        type Driver = {
          kind: string;
          execute: (sql: string, params?: unknown[]) => Promise<unknown>;
          select: (sql: string, params?: unknown[]) => Promise<unknown[]>;
          transaction: (fn: (tx: { execute: Driver['execute']; select: Driver['select'] }) => Promise<unknown>) => Promise<unknown>;
          close: () => Promise<void>;
        };
        const db = (await drivers.openSqliteWasmDriver()) as unknown as Driver;
        await migrator.migrate(db, migrations.slice(0, -1));
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
        const hlc = `${String(Date.now()).padStart(15, '0')}-0000-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        await db.execute(
          `INSERT INTO task (id, space_id, project_id, title, note, date, time, status, done_at, sort_order, carried_over, recurrence_id, series_index, goal_id, icon, someday, source, external_id, series_template, external_event_id, created_at, deleted_at, updated_at, device_id, hlc)
           VALUES ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-000000000001', NULL, ?, '', ?, NULL, 'todo', NULL, 1, 0, NULL, NULL, NULL, NULL, 0, 'local', NULL, NULL, NULL, '2026-10-01T08:00:00.000Z', NULL, '2026-10-01T08:00:00.000Z', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ?)`,
          [title, today, hlc],
        );
        await db.execute('DELETE FROM sync_outbox');
        if (mode === 'newer') {
          // Base passée par une version plus récente (N+2), puis IPA plus ancienne réinstallée.
          await migrator.migrate(db, migrations);
          await db.execute("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', '00000000', '2026-10-20T08:00:00.000Z')");
        }
        if (mode !== 'fail') return db;
        // Migration volontairement en échec : toute instruction de la dernière migration (colonnes Rappels Apple) est refusée.
        const refuse = (sql: string): boolean => sql.includes('apple_list_id');
        return {
          kind: db.kind,
          execute: (sql: string, params?: unknown[]) => (refuse(sql) ? Promise.reject(new Error('échec simulé de la migration')) : db.execute(sql, params)),
          select: (sql: string, params?: unknown[]) => db.select(sql, params),
          transaction: (fn: Parameters<Driver['transaction']>[0]) =>
            db.transaction((tx) => fn({ select: (sql, params) => tx.select(sql, params), execute: (sql, params) => (refuse(sql) ? Promise.reject(new Error('échec simulé de la migration')) : tx.execute(sql, params)) })),
          close: () => db.close(),
        };
      };
      if (mode === 'fail') {
        const pad = (n: number): string => String(n).padStart(4, '0');
        g['__ctMigrationBackup'] = {
          backup: (request: { fromVersion: number; toVersion: number; stamp: string }) =>
            Promise.resolve({ name: `circletasks-pre-migration-v${pad(request.fromVersion)}-to-v${pad(request.toVersion)}-${request.stamp}.db` }),
        };
        g['__ctRestored'] = [];
        g['__ctStartupRecovery'] = {
          available: () => true,
          list: () => Promise.resolve({ directory: null, versions: [] }),
          createDaily: () => Promise.resolve({ created: false }),
          restore: (request: { name: string }) => {
            (g['__ctRestored'] as string[]).push(request.name);
            return Promise.resolve({ marker: 'not-configured', markerCode: null });
          },
          restart: () => new Promise<void>(() => undefined),
        };
      }
    },
    { mode, title: TITLE },
  );
}

test.describe('I-06 — mise à jour N vers N+1 (iPhone, base préremplie, version simulée)', () => {
  test.use({ userAgent: IPHONE_UA });
  test.skip(({ isMobile }) => !isMobile, 'La mise à jour par SideStore concerne l’iPhone (projet iphone).');

  test('premier lancement de 0.3.0 : Aujourd’hui avec la tâche d’avant, « À propos » affiche 0.3.0, aucun écran d’échec', async ({ page }) => {
    await installAtN(page, 'update');
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('data-db-status', 'ready', { timeout: APP_READY_TIMEOUT_MS });
    await expect(page.getByText(TITLE)).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
    await expect(page.getByTestId('db-failure-detail')).toHaveCount(0);
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await expect(page.getByText('Version 0.3.0', { exact: true })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  });

  test('migration en échec : écran d’échec avec étape, versions, trois actions ; « Restaurer » confirmé appelle la restauration', async ({ page }) => {
    await installAtN(page, 'fail');
    await page.goto('/');
    await expect(page.getByRole('alert').first()).toHaveText('Impossible d’ouvrir la base de données.', { timeout: APP_READY_TIMEOUT_MS });
    await expect(page.getByText('Vos données sont intactes. Ne supprimez pas CircleTasks. Envoyez le détail pour obtenir un correctif.')).toBeVisible();
    const detail = page.getByTestId('db-failure-detail');
    await expect(detail).toContainText('Étape : migration 18');
    await expect(detail).toContainText('Version de l’app : 0.3.0');
    await expect(detail).toContainText('Schéma de la base : 17 (dernier connu de l’app : 18)');
    await expect(detail).toContainText('Sauvegarde d’avant la mise à jour : circletasks-pre-migration-v0017-to-v0018-');
    await expect(page.getByRole('button', { name: 'Réessayer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copier le détail' })).toBeVisible();
    const restore = page.getByRole('button', { name: 'Restaurer la sauvegarde d’avant la mise à jour' });
    await expect(restore).toBeVisible();
    const box = await restore.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    await restore.click();
    const dialog = page.getByRole('alertdialog', { name: 'Restaurer la sauvegarde d’avant la mise à jour ?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Restaurer', exact: true }).click();
    await expect(page.getByText('Restauration en cours…')).toBeVisible();
    const restored = await page.evaluate(() => (globalThis as { __ctRestored?: string[] }).__ctRestored ?? []);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatch(/^circletasks-pre-migration-v0017-to-v0018-\d{8}T\d{6}Z\.db$/);
  });

  test('base plus récente que l’app : consigne SideStore, données non modifiées, pas de restauration, jamais de page blanche', async ({ page }) => {
    await installAtN(page, 'newer');
    await page.goto('/');
    await expect(page.getByRole('alert').first()).toHaveText(
      'Cette version de CircleTasks est plus ancienne que vos données. Installez la dernière version depuis SideStore. Vos données ne sont pas modifiées.',
      { timeout: APP_READY_TIMEOUT_MS },
    );
    await expect(page.getByText(/inconnue de cette version/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copier le détail' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restaurer la sauvegarde d’avant la mise à jour' })).toHaveCount(0);
  });
});
