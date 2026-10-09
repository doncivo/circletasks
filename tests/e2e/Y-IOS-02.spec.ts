import { expect, test } from '@playwright/test';
import { createTask } from './helpers/today';
import { APP_READY_TIMEOUT_MS } from './helpers/app';
import { closeRoom, openSyncDetails, openSyncedPage, openTasks, presentQr, propagate, setCamera, syncNow, taskRow, type SyncedPage } from './helpers/sync';

/**
 * Y-IOS-02 critère 17 (ADR 0011 §23 points 2 et 7) : projet `iphone`, simulateur de dossier. Le PC publie une tâche ; l'iPhone a le dossier
 * du PC, sans clé (`bare`). Caméra refusée : dite sur la ligne de Réglages, bandeau persistant « associez cet appareil » ; autorisée :
 * « Associer au PC » → scan simulé (texte du QR produit par le simulateur, jamais par la page) → clé reçue → tâche du PC visible. L'iPhone
 * n'affiche jamais le QR. Le refus de la confirmation de remplacement est couvert par `yIos02.test.tsx` (clé déjà présente sur l'iPhone).
 */

const PC = { project: { name: 'pc' } };
const TITLE = 'Créée sur le PC';

/**
 * Budget : deux apps démarrées, quatre cycles et une arrivée. Mesuré le 2026-10-08 (projet iphone, 1 worker, serveur de dev compilé) ;
 * sans `test.slow()` ni nouvel essai (consigne d'Ali).
 */
const BUDGET_MS = 40_000;

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

test('Y-IOS-02 : caméra refusée visible, puis « Associer au PC » par le scan, tâche du PC lisible sur l’iPhone', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  // PC : dossier et clé, tâche publiée.
  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await createTask(pc.page, PC, { title: TITLE, time: '08:00' });
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);

  // iPhone : dossier du PC, sans clé.
  const phone = await openSyncedPage(browser, room, 'iphone', 'bare', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await setCamera(room, 'iphone', 'denied');
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByTestId('sync-camera-denied')).toHaveText('L’accès à la caméra est refusé', { timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: 'Ouvrir les réglages d’iOS pour autoriser la caméra' })).toBeVisible();
  await expect(page.locator('.ct-status-banner').filter({ hasText: 'Associez cet iPhone au PC pour synchroniser' })).toBeVisible();
  await page.getByRole('button', { name: 'Ouvrir les réglages d’iOS pour autoriser la caméra' }).click();
  expect((await setCamera(room, 'iphone', 'denied')).opened).toBe(1);

  // Autorisation rendue dans les réglages d'iOS : relue au retour au premier plan, l'état disparaît.
  await setCamera(room, 'iphone', 'granted');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('sync-camera-denied')).toHaveCount(0);

  // « Associer au PC » : dossier déjà choisi, explication de la caméra, scan simulé, clé reçue.
  await presentQr(room, 'iphone', 'pc');
  await page.getByRole('button', { name: 'Associer cet iPhone au PC : scanner le code d’association' }).click();
  const dialog = page.getByRole('dialog', { name: 'Scannez le code affiché sur le PC' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/CircleTasks utilise la caméra pour scanner le code d’association/)).toBeVisible();
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' }).click();
  await expect(page.getByText('Cet iPhone est associé au PC')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();

  // La tâche du PC est arrivée (cycle lancé à l'association).
  await openSyncDetails(page);
  await syncNow(page);
  await openTasks(page);
  await expect(taskRow(page, TITLE)).toBeVisible();
  await expect(page.locator('.ct-status-banner').filter({ hasText: 'Associez cet iPhone au PC pour synchroniser' })).toHaveCount(0);
});

test('Y-IOS-02 QA : écrans d’association de l’iPhone, dossier d’abord, puis caméra expliquée et scan', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02f-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await createTask(pc.page, PC, { title: TITLE, time: '08:00' });
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);

  // iPhone sans dossier ni clé : Réglages propose d'abord le dossier.
  const phone = await openSyncedPage(browser, room, 'iphone', 'nofolder', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await presentQr(room, 'iphone', 'pc');
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await page.getByRole('button', { name: 'Associer cet iPhone au PC : scanner le code d’association' }).click({ timeout: APP_READY_TIMEOUT_MS });
  const dialog = page.getByRole('dialog', { name: 'Scannez le code affiché sur le PC' });
  await expect(dialog).toBeVisible();
  // Étape 1 : le dossier, rien d'autre (ni caméra, ni scan, ni QR).
  await expect(dialog.getByText('Choisissez d’abord le même dossier iCloud Drive / CircleTasks que sur le PC.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Choisir le dossier iCloud Drive / CircleTasks' }).click();
  // Étape 2 : la caméra expliquée, puis le scan.
  await expect(dialog.getByText(/CircleTasks utilise la caméra pour scanner le code d’association/)).toBeVisible();
  await expect(dialog.getByText('Choisissez d’abord le même dossier iCloud Drive / CircleTasks que sur le PC.')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Ouvrir la caméra et scanner le code d’association' }).click();
  await expect(page.getByText('Cet iPhone est associé au PC')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await openSyncDetails(page);
  await syncNow(page);
  await openTasks(page);
  await expect(taskRow(page, TITLE)).toBeVisible();
});
