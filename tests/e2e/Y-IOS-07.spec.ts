import { expect, test } from '@playwright/test';
import { createTask } from './helpers/today';
import { closeRoom, inspect, openSyncDetails, openSyncedPage, openTasks, syncNow, type SyncedPage } from './helpers/sync';

let room = '';
let opened: SyncedPage | null = null;
test.beforeEach(({ browser }, info) => { void browser; room = `head-evicted-${info.project.name}-${info.testId}`; });
test.afterEach(async () => { await opened?.context.close(); opened = null; await closeRoom(room); });

test('Y-IOS-07 : le refus avant écriture ouvre le segment suivant et la saisie iPhone est publiée une fois', async ({ browser }) => {
  opened = await openSyncedPage(browser, room, 'iphone', 'first');
  const { page } = opened;
  await openSyncDetails(page);
  await syncNow(page);
  await openTasks(page);
  await createTask(page, { project: { name: 'iphone' } }, { title: 'Avant éviction' });
  await openSyncDetails(page);
  await syncNow(page);
  const calls: { segment: number; expectRecords: number }[] = [];
  let refuseHead = true;
  await page.route('**/rpc', async (route) => {
    const body = route.request().postDataJSON() as { path?: string; args?: { segment: number; expectRecords: number }[] };
    if (body.path === 'appendJournal') {
      const request = body.args?.[0];
      if (!request) throw new Error('requête append absente');
      calls.push({ segment: request.segment, expectRecords: request.expectRecords });
      if (refuseHead) {
        refuseHead = false;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: { code: 'cloud-pending', appendBeforeWrite: true } }) });
        return;
      }
    }
    await route.continue();
  });
  await openTasks(page);
  await createTask(page, { project: { name: 'iphone' } }, { title: 'Après éviction' });
  await openSyncDetails(page);
  await syncNow(page);
  expect(calls).toHaveLength(2);
  expect(calls[0]?.expectRecords).toBeGreaterThan(0);
  expect(calls[1]).toEqual({ segment: (calls[0]?.segment ?? 0) + 1, expectRecords: 0 });
  const remote = await inspect(room, 'iphone');
  expect(Object.values(remote.tasks)).toEqual([1, 1]);
});
