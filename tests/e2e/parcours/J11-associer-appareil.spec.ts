import { expect, test } from '@playwright/test';
import { createTask } from '../helpers/today';
import { APP_READY_TIMEOUT_MS } from '../helpers/app';
import { closeRoom, inspect, openPairingWindow, openSyncDetails, openSyncedPage, openTasks, propagate, syncNow, taskRow, type SyncedPage } from '../helpers/sync';

/**
 * Parcours clé 11 (PRD 8 ; P-05, Y-01, Y-06, Y-08 ; ADR 0011 §12 ; Y-06 critère 20) : « Associer un appareil au PC, choisir le dossier
 * iCloud, vérifier qu'une tâche créée sur le PC est lisible sur le second appareil », sur deux pages du navigateur de dev reliées par le
 * simulateur de dossier (`tests/sim/syncFolderSim.ts`). La fenêtre dédiée `pairing.html` est servie par Vite avec une plateforme
 * réduite adossée au simulateur, qui tient le rôle de Rust (instance ouverte par la fenêtre principale, jeton, mode).
 *
 * Le second appareil est un second PC (la saisie de la clé de secours se fait dans la fenêtre `pairing` sur PC) : il reçoit le dossier du
 * premier sans clé (rôle `bare`, dossier d'abord), s'associe par la clé de secours affichée sur le PC, puis reçoit la tâche. La partie
 * « scan réel par l'iPhone » est de l'ordre 5. Le chiffrement des fichiers est prouvé par le parcours 11 en Vitest (codec de référence)
 * et par `cargo test` ; le simulateur garde le texte clair.
 */

const PC = { project: { name: 'pc' } };
const TITLE = 'Test synchro';

let opened: SyncedPage[] = [];
let room = '';

/**
 * Budget du parcours 11 : deux apps démarrées (bases neuves), deux fenêtres `pairing`, quatre cycles de synchro. Durée mesurée le
 * 2026-10-06 (projet pc, `--repeat-each=3`, 2 workers, serveur de dev déjà compilé) : 10,4 à 17,4 s ; budget 40 s, un peu plus du
 * double du pire mesuré, au lieu du triplement implicite de `test.slow()` (consigne d'Ali : ni `test.slow()` ni retry).
 */
const PARCOURS_BUDGET_MS = 40_000;

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

test('parcours 11 : le PC affiche le QR et la clé de secours, « Nouveau code » remplace le code, le second appareil s’associe par la clé de secours et lit la tâche', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'lancé une fois, depuis le projet pc');
  test.setTimeout(PARCOURS_BUDGET_MS);
  room = `j11-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  // PC : dossier choisi et clé créée (premier appareil), tâche créée et publiée.
  const pc = await openSyncedPage(browser, room, 'pc', 'first');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await createTask(pc.page, PC, { title: TITLE, time: '08:00' });
  await openSyncDetails(pc.page);
  await syncNow(pc.page);

  // « Associer l'iPhone » : la fenêtre principale ouvre l'instance `show` (confirmation native simulée), puis la fenêtre `pairing`.
  await pc.page.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }).click();
  await expect(pc.page.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' })).toBeEnabled();
  const show = await openPairingWindow(pc.context, room, 'pc');
  await expect(show.getByRole('heading', { level: 1, name: 'Associer l’iPhone' })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  const qr = show.getByRole('img', { name: 'QR code d’association' });
  await expect(qr).toBeVisible();
  const key = show.getByTestId('pairing-recovery-key');
  await expect(key).toHaveText(/^CT1(-[0-9A-Z]{5})+$/);
  const recoveryKey = (await key.textContent()) ?? '';
  await expect(show.getByText('Code valable 5 minutes')).toBeVisible();
  await expect(show.getByText('En attente de l’iPhone…')).toBeVisible();
  await expect(show.getByRole('button', { name: /copier/i })).toHaveCount(0);
  // « Nouveau code » : nouvelle génération, nouveau QR (échéance différente), même clé de secours.
  const firstPath = await qr.locator('path').getAttribute('d');
  await show.getByRole('button', { name: 'Afficher un nouveau code (nouvelle confirmation)' }).click();
  await expect(qr.locator('path')).not.toHaveAttribute('d', firstPath ?? '');
  await expect(key).toHaveText(recoveryKey);
  // « Annuler » : la fenêtre se vide (Rust la détruirait).
  await show.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }).click();
  await expect(key).toHaveCount(0);
  await show.close();
  await propagate(room);

  // Second appareil : dossier du PC choisi, sans clé : la ligne de Réglages le dit et propose « Associer cet appareil » (D1).
  const second = await openSyncedPage(browser, room, 'pc2', 'bare', 'pc');
  opened.push(second);
  await second.page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(second.page.getByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  const associate = second.page.getByRole('button', { name: 'Associer cet appareil avec la clé de secours' });
  await expect(associate).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await associate.click();
  const entry = await openPairingWindow(second.context, room, 'pc2');
  const field = entry.getByLabel('Clé de secours');
  await expect(field).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(field).toHaveAttribute('autocomplete', 'off');
  // Saisie tolérante (minuscules, espaces) : décodée par la plateforme, jamais par l'interface.
  await field.fill(recoveryKey.toLowerCase().replace(/-/g, ' '));
  await entry.getByRole('button', { name: 'Associer', exact: true }).click();
  await expect(entry.getByText('Cet appareil est associé')).toBeVisible();
  await expect(field).toHaveValue('');
  await entry.close();

  // Dans l'app installée, `sync-paired` (Rust) rafraîchit la ligne et lance le premier cycle ; le navigateur de dev n'a pas cet
  // événement : on revient dans Réglages (la ligne relit la clé, présente) puis on synchronise. La tâche du PC est lisible.
  await openTasks(second.page);
  await openSyncDetails(second.page);
  await syncNow(second.page);
  await openTasks(second.page);
  await expect(taskRow(second.page, TITLE)).toBeVisible();

  // Le PC voit le second appareil, qui a publié son état.
  await propagate(room);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await openTasks(pc.page);
  await expect(taskRow(pc.page, TITLE)).toBeVisible();
  expect((await inspect(room, 'pc2')).deviceId).not.toBeNull();
});
