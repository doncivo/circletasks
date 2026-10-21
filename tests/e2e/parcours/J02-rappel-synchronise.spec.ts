import { expect, test, type Page } from '@playwright/test';
import { pushAction, taskRequests } from '../helpers/notifications';
import { closeRoom, openSyncedPage, openSyncDetails, openTasks, propagate, syncNow, taskRow, type SyncedPage } from '../helpers/sync';
import { createTask } from '../helpers/today';

/** REL-01 / PRD 8 : parcours 2 complet au niveau applicatif, sur PC et iPhone simulés.
 * Le planificateur et l'action remplacent iOS ; la réception physique reste dans le guide de l'IPA.
 * Budget initial de 40 s : deux démarrages et cinq cycles, même budget que le parcours J10.
 */
const BUDGET_MS = 40_000;
const NOW = new Date('2026-09-23T09:00:00+02:00');
const FIRE = new Date('2026-09-23T10:00:00+02:00');
const TITLE = 'Rappel du parcours 2';
const PC = { project: { name: 'pc' } };
let opened: SyncedPage[] = [];
let room = '';

async function preparePhone(page: Page): Promise<void> {
  await page.clock.install({ time: NOW });
  await page.addInitScript(() => {
    (globalThis as { __ctNotificationsFake?: boolean }).__ctNotificationsFake = true;
    (globalThis as { __ctNotificationActionsFake?: boolean }).__ctNotificationActionsFake = true;
  });
}

test.afterEach(async () => {
  await Promise.all(opened.map((app) => app.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

test('parcours 2 : tâche PC, rappel iPhone et action Fait renvoyée au PC', async ({ browser }, info) => {
  test.setTimeout(BUDGET_MS);
  room = `j02-${info.project.name}-${String(info.workerIndex)}-${info.testId}`;
  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc', async (page) => { await page.clock.install({ time: NOW }); });
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await createTask(pc.page, PC, { title: TITLE, time: '10:00' });
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);

  const phone = await openSyncedPage(browser, room, 'iphone', 'join', 'iphone', preparePhone);
  opened.push(phone);
  await openSyncDetails(phone.page);
  await syncNow(phone.page);
  await openTasks(phone.page);
  await expect(taskRow(phone.page, TITLE)).toContainText('10:00');
  await expect.poll(() => taskRequests(phone.page)).toEqual([
    expect.objectContaining({ title: TITLE, fireAt: '2026-09-23T10:00', body: '10:00 · Pro', category: 'task' }),
  ]);
  expect(await taskRequests(pc.page)).toEqual([]);
  const [request] = await taskRequests(phone.page);
  if (!request) throw new Error('rappel attendu sur iPhone');

  await Promise.all([pc.page.clock.setFixedTime(FIRE), phone.page.clock.setFixedTime(FIRE)]);
  await pushAction(phone.page, 'done', request.id);
  await expect(phone.page.getByRole('checkbox', { name: `Rouvrir : ${TITLE}` })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => taskRequests(phone.page)).toEqual([]);
  await openSyncDetails(phone.page);
  await syncNow(phone.page);
  await propagate(room);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await expect(taskRow(pc.page, TITLE)).toHaveCount(1);
  await expect(pc.page.getByRole('checkbox', { name: `Rouvrir : ${TITLE}` })).toHaveAttribute('aria-checked', 'true');
  expect(await taskRequests(pc.page)).toEqual([]);
});
