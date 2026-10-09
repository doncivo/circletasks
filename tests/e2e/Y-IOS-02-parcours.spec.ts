import { expect, test, type Page } from '@playwright/test';
import { createTask } from './helpers/today';
import { APP_READY_TIMEOUT_MS } from './helpers/app';
import { expectFitsViewport } from './helpers/layout';
import { closeRoom, inspect, openPairingWindow, openSyncDetails, openSyncedPage, openTasks, presentQr, presentText, propagate, setCamera, syncNow, taskRow, type SyncedPage } from './helpers/sync';

/**
 * Y-IOS-02, QA du parcours d'association (demande d'Ali, 0.2.2) : parcours complet PC + iPhone de bout en bout sur deux pages reliées par
 * le simulateur de dossier (`tests/sim/syncFolderSim.ts`), avec l'agent iOS et l'os `ios` du simulateur posés par `openSyncedPage` (la page
 * de l'iPhone annonce `platform: 'ios'` ; les autres projets et tests ne sont pas touchés). Chaque écran du parcours est vérifié à
 * 440 × 956 : aucun défilement horizontal, aucun élément hors de la largeur. Les états d'échec (scan annulé, QR illisible, caméra refusée,
 * clé de secours erronée) sont rejoués dans le même parcours : à chaque fois, l'action utile reste, puis l'association réussit.
 *
 * Projet `iphone` : le parcours (les deux pages) ; projet `pc` : les états du PC (voir `Y-IOS-02-etats.spec.ts`).
 */

const PC = { project: { name: 'pc' } };
const TITLE = 'Créée sur le PC';
const SHOW_QR = 'Associer l’iPhone : afficher le code d’association';
const ASSOCIATE_PC = 'Associer cet iPhone au PC : scanner le code d’association';
const SCAN = 'Ouvrir la caméra et scanner le code d’association';
const OPEN_SETTINGS = 'Ouvrir les réglages d’iOS pour autoriser la caméra';
const RECOVERY = 'Saisir la clé de secours imprimée à la place du code';
const BANNER = 'Associez cet iPhone au PC pour synchroniser';

/** Budget : deux apps démarrées, une dizaine de cycles et d'écrans, une arrivée (consigne d'Ali : ni `test.slow()` ni nouvel essai). */
const BUDGET_MS = 90_000;

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

const reglages = (page: Page) => page.getByRole('navigation').getByText('Réglages', { exact: true });

test('Y-IOS-02 QA : PC + iPhone de bout en bout, échecs d’association puis réussite, 440 × 956 sans débordement à chaque écran', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02qa-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  // --- PC : dossier, clé, tâche publiée ; « Associer l'iPhone » directement dans Réglages ---------------------------------------------
  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await createTask(pc.page, PC, { title: TITLE, time: '08:00' });
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);
  await reglages(pc.page).click();
  await expect(pc.page.getByRole('button', { name: SHOW_QR })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(pc.page.getByRole('button', { name: 'Synchroniser', exact: true })).toBeVisible();

  // --- iPhone sans dossier ni clé : Réglages propose l'association (qui commence par le dossier) --------------------------------------
  const phone = await openSyncedPage(browser, room, 'iphone', 'nofolder', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await reglages(page).click();
  const associate = page.getByRole('button', { name: ASSOCIATE_PC });
  await expect(associate).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: 'Choisir le dossier de synchronisation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Synchroniser', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toHaveCount(0);
  await expectFitsViewport(page, 'Réglages › Synchronisation, aucun dossier');

  // Écran « Associer au PC », étape 1 : le dossier.
  await associate.click();
  const dialog = page.getByRole('dialog', { name: 'Scannez le code affiché sur le PC' });
  await expect(dialog.getByText('Choisissez d’abord le même dossier iCloud Drive / CircleTasks que sur le PC.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: SCAN })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: RECOVERY })).toHaveCount(0);
  await expectFitsViewport(page, 'Associer au PC, étape dossier');
  await dialog.getByRole('button', { name: 'Choisir le dossier iCloud Drive / CircleTasks' }).click();

  // Étape 2 : la caméra expliquée.
  await expect(dialog.getByText(/CircleTasks utilise la caméra pour scanner le code d’association/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: SCAN })).toBeVisible();
  await expect(dialog.getByRole('button', { name: RECOVERY })).toBeVisible();
  await expectFitsViewport(page, 'Associer au PC, étape caméra');

  // Scan annulé : dit, rescanner possible.
  await presentText(room, 'iphone', null);
  await dialog.getByRole('button', { name: SCAN }).click();
  await expect(page.getByTestId('ios-pairing-message')).toHaveText('Scan annulé');
  await expect(dialog.getByRole('button', { name: SCAN })).toBeVisible();
  await expectFitsViewport(page, 'Associer au PC, scan annulé');

  // QR illisible (pas un code CircleTasks) : dit, rescanner possible, aucune clé.
  await presentText(room, 'iphone', 'https://exemple.test/pas-un-code');
  await dialog.getByRole('button', { name: SCAN }).click();
  await expect(page.getByTestId('ios-pairing-message')).toHaveText('Ce code n’est pas un code d’association CircleTasks : affichez le code sur le PC et réessayez');
  await expect(dialog.getByRole('button', { name: SCAN })).toBeVisible();
  await expectFitsViewport(page, 'Associer au PC, QR illisible');

  // Caméra refusée à la demande d'iOS : dit, « Ouvrir les réglages » proposé, clé de secours possible.
  await setCamera(room, 'iphone', 'prompt', 'denied');
  await dialog.getByRole('button', { name: SCAN }).click();
  await expect(page.getByTestId('ios-camera-denied')).toHaveText('L’accès à la caméra est refusé');
  await expect(dialog.getByRole('button', { name: OPEN_SETTINGS })).toBeVisible();
  await expect(dialog.getByRole('button', { name: RECOVERY })).toBeVisible();
  await expectFitsViewport(page, 'Associer au PC, caméra refusée');
  await dialog.getByRole('button', { name: OPEN_SETTINGS }).click();
  expect((await setCamera(room, 'iphone', 'denied')).opened).toBe(1);

  // Clé de secours erronée : dite, saisie et « Annuler » restent ; « Annuler » ramène au scan.
  await dialog.getByRole('button', { name: RECOVERY }).click();
  const field = page.getByLabel('Clé de secours');
  await expect(field).toBeVisible();
  await field.fill('CT1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG');
  await page.getByRole('button', { name: 'Associer', exact: true }).click();
  await expect(page.getByTestId('pairing-import-message')).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Associer', exact: true })).toBeEnabled();
  await expectFitsViewport(page, 'Associer au PC, clé de secours erronée');
  await page.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }).click();

  // Autorisation rendue dans les réglages d'iOS : relue au retour au premier plan.
  await setCamera(room, 'iphone', 'granted');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByRole('button', { name: SCAN })).toBeVisible();
  await expect(page.getByTestId('ios-camera-denied')).toHaveCount(0);

  // Le bon code : associé.
  await presentQr(room, 'iphone', 'pc');
  await dialog.getByRole('button', { name: SCAN }).click();
  await expect(page.getByText('Cet iPhone est associé au PC')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByTestId('ios-pairing-message')).toHaveCount(0);
  await expectFitsViewport(page, 'Associer au PC, associé');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();

  // Réglages après association : plus d'association, état normal, « Synchroniser » ; aucun QR.
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toHaveCount(0);
  await expect(page.getByRole('button', { name: SHOW_QR })).toHaveCount(0);
  await expect(page.locator('.ct-status-banner').filter({ hasText: BANNER })).toHaveCount(0);
  await expectFitsViewport(page, 'Réglages › Synchronisation, associé');

  // Détails : « Synchroniser », « Réinitialiser » (la clé est là) ; la tâche du PC arrive.
  await openSyncDetails(page);
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toHaveCount(0);
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await syncNow(page);
  await expect(page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeVisible();
  await expect(page.getByTestId('sync-key-id')).toBeVisible();
  await expectFitsViewport(page, 'Détails de la synchronisation, associé');
  await openTasks(page);
  await expect(taskRow(page, TITLE)).toBeVisible();
  await expectFitsViewport(page, 'Tâches après association');

  // --- PC : voit l'iPhone dans APPAREILS --------------------------------------------------------------------------------------------
  await propagate(room);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await expect(pc.page.locator('.ct-sync__device')).toHaveCount(2);
  expect((await inspect(room, 'iphone')).deviceId).not.toBeNull();
});

test('Y-IOS-02 QA : fenêtre QR du PC, état d’attente, nouveau code, annulation', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'PC seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02qb-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await reglages(pc.page).click();
  const show = pc.page.getByRole('button', { name: SHOW_QR });
  await expect(show).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await show.click();
  await expect(show).toBeEnabled();
  const window = await openPairingWindow(pc.context, room, 'pc');
  await expect(window.getByRole('img', { name: 'QR code d’association' })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(window.getByText('En attente de l’iPhone…')).toBeVisible();
  await expect(window.getByText('Sur l’iPhone, ouvrez Réglages → Synchronisation → Associer au PC.')).toBeVisible();
  await expect(window.getByRole('button', { name: 'Afficher un nouveau code (nouvelle confirmation)' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' })).toBeVisible();
  await expectFitsViewport(window, 'Fenêtre QR du PC');
  await window.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }).click();
  await expect(window.getByRole('button', { name: 'Fermer', exact: true })).toBeVisible();
  await expect(window.getByRole('img', { name: 'QR code d’association' })).toHaveCount(0);
  await expect(window.getByTestId('pairing-recovery-key')).toHaveCount(0);
});

test('Y-IOS-02 QA : le contrôle de largeur détecte un débordement à droite (témoin du contrôle)', async ({ page }) => {
  await page.setContent('<body style="margin:0"><div style="width:calc(100vw + 120px);height:20px;background:#ccc">trop large</div></body>');
  await expect(expectFitsViewport(page, 'témoin')).rejects.toThrow();
  await page.setContent('<body style="margin:0"><div style="width:100%;height:20px;background:#ccc">à la bonne largeur</div></body>');
  await expectFitsViewport(page, 'témoin');
});
