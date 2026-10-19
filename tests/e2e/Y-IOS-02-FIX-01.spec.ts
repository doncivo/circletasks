import { expect, test } from '@playwright/test';
import { closeRoom, failAfter, inspect, openSyncDetails, openSyncedPage, SYNC_SIM_URL, syncNow, syncStatusLine, type SyncedPage } from './helpers/sync';
import { migrations } from '../../src/db/migrations';

const SCHEMA_VERSION = migrations.at(-1)?.version ?? 1;

let room: string;
let opened: SyncedPage | null = null;
test.beforeEach(({ browser }, info) => { void browser; room = `own-deletion-${info.project.name}-${info.testId}`; });
test.afterEach(async () => { await opened?.context.close(); opened = null; await closeRoom(room); });

test('Y-IOS-02-FIX-01 : échec visible sur iPhone, cause et dossier, nouvelle tentative manuelle puis résolution', async ({ browser, request }) => {
  opened = await openSyncedPage(browser, room, 'iphone', 'first');
  const { page } = opened;
  await openSyncDetails(page);
  await syncNow(page);
  const self = (await inspect(room, 'iphone')).deviceId;
  expect(self).toMatch(/^[0-9a-f-]{36}$/);
  const epoch = `e0001-${String(self)}`;
  // Trois vrais instantanés dans le faux dossier : le moteur doit supprimer le premier en gardant les deux derniers.
  for (const seq of [2, 3]) {
    const response = await request.post(`${SYNC_SIM_URL}/rpc`, { data: { room, device: 'iphone', role: 'first', platform: 'ios', path: 'writeSnapshot', args: [{ epoch, seq, sv: SCHEMA_VERSION, records: [[JSON.stringify({ k: 'snap-end', count: 0, covers: {}, epoch, sv: SCHEMA_VERSION })]] }] } });
    expect(response.ok()).toBe(true);
    expect(await response.json()).toHaveProperty('ok');
  }
  await failAfter(room, 'iphone', 'deleteOwn', 0, 'io');
  await syncNow(page, /^Synchro incomplète/);
  const failure = page.locator('.ct-sync__ownDeletion');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Des fichiers anciens de cet appareil n'ont pas pu être supprimés");
  await expect(failure).toContainText('CircleTasks › devices');
  await expect(failure).toContainText(epoch);
  await expect(failure).toContainText(/Dernier essai à \d{2}:\d{2}/);

  // Tenir la seule unité de suppression pour observer l'état occupé, sans délai ni attente chronométrée.
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { started = resolve; });
  let holdNext = true;
  await page.route('**/rpc', async (route) => {
    if (route.request().postDataJSON()?.path === 'deleteOwn' && holdNext) {
      holdNext = false;
      started();
      await held;
    }
    await route.continue();
  });
  try {
    const retry = page.getByRole('button', { name: 'Réessayer maintenant', exact: true });
    await retry.click();
    await reached;
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveAttribute('aria-busy', 'true');
    await expect(failure).toBeVisible();
  } finally {
    release();
  }
  await expect(failure).toHaveCount(0);
  await expect(syncStatusLine(page)).toHaveText(/^À jour/);
});
