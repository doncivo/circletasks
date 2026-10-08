import { expect, test, type Page } from '@playwright/test';
import { createTask } from './helpers/today';
import { APP_READY_TIMEOUT_MS } from './helpers/app';
import { closeRoom, inspect, openSyncDetails, openSyncedPage, openTasks, setUnreachable, syncNow, syncStatusLine, type SyncedPage } from './helpers/sync';

/**
 * Y-IOS-01 critère 14 (ADR 0011 §22) : projet `iphone`, simulateur de dossier, plateforme `ios`. Dossier choisi, tâche créée, page passée en
 * arrière-plan : le cycle `hide` part aussitôt, borné (budget d'hydratation reçu par le scan : échéance de 25 s moins 2 s) ; retour au
 * premier plan : cycle `open`. Dossier rendu injoignable (signet perdu) : bandeau au texte de l'iPhone, toujours visible après un
 * rechargement de la page, disparu quand le dossier est rétabli.
 */

const IPHONE = { project: { name: 'iphone' } };
const IOS_TEXT = 'Dossier iCloud Drive inaccessible : choisissez de nouveau le dossier iCloud Drive / CircleTasks';

/**
 * Budget : une app démarrée, un rechargement, six cycles. Mesuré le 2026-10-08 (projet iphone, 1 worker, serveur de dev compilé) : 8 à 10 s ;
 * budget de 30 s, sans `test.slow()` ni nouvel essai (consigne d’Ali).
 */
const BUDGET_MS = 30_000;

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

/** Visibilité de la page (WKWebView : `visibilitychange` au passage en arrière-plan), posée comme le ferait iOS. */
async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('Y-IOS-01 : cycle borné au passage en arrière-plan, signet perdu visible et persistant, rétabli', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios01-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  const phone = await openSyncedPage(browser, room, 'iphone', 'first', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await openSyncDetails(page);
  await syncNow(page);

  // Tâche créée, puis l'app passe en arrière-plan : le cycle `hide` publie la tâche, sous une échéance (budget d'hydratation du scan).
  await openTasks(page);
  await createTask(page, IPHONE, { title: 'Créée sur l’iPhone' });
  const before = await inspect(room, 'iphone');
  await setVisibility(page, 'hidden');
  await expect.poll(async () => (await inspect(room, 'iphone')).appends, { timeout: APP_READY_TIMEOUT_MS }).toBeGreaterThan(before.appends);
  const hidden = await inspect(room, 'iphone');
  const budget = hidden.scanBudgets.at(-1);
  expect(typeof budget).toBe('number');
  expect(budget as number).toBeGreaterThanOrEqual(1);
  expect(budget as number).toBeLessThanOrEqual(23_000);
  expect(Object.keys(hidden.tasks)).toHaveLength(1);

  // Retour au premier plan : un cycle d'ouverture, non borné.
  await setVisibility(page, 'visible');
  await expect.poll(async () => (await inspect(room, 'iphone')).scanBudgets.length, { timeout: APP_READY_TIMEOUT_MS }).toBeGreaterThan(hidden.scanBudgets.length);
  expect((await inspect(room, 'iphone')).scanBudgets.at(-1)).toBeNull();

  // Signet perdu : bandeau et ligne de Réglages au texte de l'iPhone.
  await setUnreachable(room, 'iphone', true);
  await openSyncDetails(page);
  await syncNow(page, new RegExp(`^${IOS_TEXT}$`));
  const banner = page.locator('.ct-status-banner').filter({ hasText: IOS_TEXT });
  await expect(banner).toBeVisible();

  // Rechargement : toujours visible (le dossier reste injoignable).
  await page.reload();
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.locator('.ct-status-banner').filter({ hasText: IOS_TEXT })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });

  // Dossier rétabli : la synchro suivante réussit, le bandeau disparaît.
  await setUnreachable(room, 'iphone', false);
  await openSyncDetails(page);
  await page.getByRole('button', { name: 'Synchroniser', exact: true }).click();
  await expect(page.locator('.ct-status-banner').filter({ hasText: IOS_TEXT })).toHaveCount(0, { timeout: APP_READY_TIMEOUT_MS });
  await expect(syncStatusLine(page)).not.toHaveText(IOS_TEXT);
});
