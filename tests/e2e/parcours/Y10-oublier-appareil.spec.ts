import { expect, test, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from '../helpers/app';
import { closeRoom, inspect, openSyncDetails, openSyncedPage, propagate, syncNow, syncStatusLine, type SyncedPage } from '../helpers/sync';

/**
 * Y-10 « J'oublie un appareil » (ADR 0011 §14.2 ; fiche Y-10, critères 1 à 4, 13, 16 et 17) sur trois pages du navigateur de dev reliées
 * par le simulateur de dossier (`tests/sim/syncFolderSim.ts`, rôle de Rust : confirmation native acceptée, `forgotten.json`, suppression) :
 * le PC oublie l'iPhone, un second PC retarde la suppression des fichiers (« en attente de {appareil} »), puis l'iPhone apprend son
 * oubli et s'associe de nouveau. Lancé une fois, depuis le projet `pc` (`--headed` pour relire les écrans, vérification manuelle 2).
 *
 * Le navigateur de dev ne garde pas la base au rechargement : « Associer de nouveau » y repart d'une base vide (dans l'app, la base est
 * gardée et fusionnée : prouvé par simulation, `tests/unit/sync/forget/forgetSim.test.ts`).
 */

let opened: SyncedPage[] = [];
let room = '';

/**
 * Budget : trois apps démarrées, une relance et une vingtaine de cycles. Durée mesurée le 2026-10-06 (projet pc, `--repeat-each=3`,
 * 2 workers, serveur de dev déjà compilé) : 14,2 à 23,9 s ; budget 50 s, un peu plus du double du pire mesuré (consigne d'Ali : ni
 * `test.slow()` ni nouvel essai).
 */
const PARCOURS_BUDGET_MS = 50_000;

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

const deviceRow = (page: Page, name: RegExp) => page.getByRole('listitem').filter({ hasText: name });

async function syncAll(pages: readonly SyncedPage[]): Promise<void> {
  for (const p of pages) {
    await propagate(room);
    await syncNow(p.page);
  }
}

test('Y-10 : oublier l’iPhone depuis le PC, suppression des fichiers en attente puis faite, l’iPhone oublié s’associe de nouveau', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'lancé une fois, depuis le projet pc');
  test.setTimeout(PARCOURS_BUDGET_MS);
  room = `y10-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  const pc = await openSyncedPage(browser, room, 'pc', 'first');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);
  const pc2 = await openSyncedPage(browser, room, 'pc2', 'join', 'pc');
  opened.push(pc2);
  const iphone = await openSyncedPage(browser, room, 'iphone', 'join');
  opened.push(iphone);
  for (const p of [pc2, iphone]) await openSyncDetails(p.page);
  await syncAll([pc2, iphone, pc, pc2, iphone, pc]);
  const iphoneId = (await inspect(room, 'iphone')).deviceId ?? '';

  // Critère 1 : « Oublier cet appareil » sur chaque autre appareil, jamais sur la ligne du PC lui-même.
  const iphoneRow = deviceRow(pc.page, /^iPhone/);
  await expect(iphoneRow.getByRole('button', { name: 'Oublier iPhone' })).toBeVisible();
  await expect(pc.page.getByRole('listitem').first().getByRole('button', { name: /Oublier/ })).toHaveCount(0);

  // Critères 2 et 4 : explication avant tout envoi, « Annuler » par défaut ; Échap annule.
  await iphoneRow.getByRole('button', { name: 'Oublier iPhone' }).click();
  const dialog = pc.page.getByRole('alertdialog', { name: 'Oublier iPhone ?' });
  await expect(dialog).toContainText('ne sera plus lu au-delà d’un point commun à tous vos appareils');
  await expect(dialog).toContainText('30 jours dans « Supprimés récemment »');
  await expect(dialog).toContainText('L’oubli ne s’annule pas');
  await expect(dialog).toContainText('garde sa copie des données et sa clé');
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused();
  await pc.page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Critère 3 : « Continuer », puis confirmation native (acceptée par le simulateur) : l'iPhone est oublié.
  await iphoneRow.getByRole('button', { name: 'Oublier iPhone' }).click();
  await dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(iphoneRow.getByText('Oublié', { exact: true })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(iphoneRow.getByRole('button')).toHaveCount(0);
  // Critère 13 : le second PC n'a pas encore accusé la déclaration : suppression en attente, et il est nommé.
  await expect(iphoneRow.getByRole('status')).toHaveText(/^Oublié · suppression des fichiers en attente de PC/);

  // Le second PC apprend l'oubli et l'accuse ; un des deux PC supprime les fichiers de l'iPhone, la ligne d'attente disparaît.
  await syncAll([pc2, pc, pc2, pc]);
  await expect(iphoneRow.getByRole('status')).toHaveCount(0);
  await expect(iphoneRow.getByText('Oublié', { exact: true })).toBeVisible();

  // Critère 16 : l'iPhone apprend son oubli : il ne lit ni ne publie plus, et le dit.
  await propagate(room);
  await syncNow(iphone.page, /^Cet appareil a été oublié : associez-le de nouveau$/);
  const appendsBefore = (await inspect(room, 'iphone')).appends;
  await syncNow(iphone.page, /^Cet appareil a été oublié/);
  expect((await inspect(room, 'iphone')).appends).toBe(appendsBefore);
  await expect(iphone.page.locator('.ct-sync__forget[role="status"]')).toContainText('Cet appareil a été oublié : associez-le de nouveau');
  // Bandeau A-09 (ADR 0011 §19) depuis l'écran principal, avec « Voir ».
  await expect(iphone.page.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeVisible();

  // Critère 17 : « Associer de nouveau » : confirmation, dossier délié (clé gardée), dossier choisi de nouveau, relance sous un nouvel identifiant.
  await iphone.page.getByRole('button', { name: 'Associer de nouveau cet appareil' }).click();
  const rejoin = iphone.page.getByRole('alertdialog', { name: 'Associer de nouveau cet appareil ?' });
  await expect(rejoin).toContainText('Rien n’est effacé');
  // La relance (rechargement de la page) arrive après le choix du dossier : attendre l'événement load, pas la barre d'onglets, encore
  // visible sur l'ancienne page (sous charge, le rechargement détruisait le contexte pendant openSyncDetails).
  const reloaded = iphone.page.waitForEvent('load', { timeout: APP_READY_TIMEOUT_MS });
  await rejoin.getByRole('button', { name: 'Associer de nouveau' }).click();
  await reloaded;
  await expect(iphone.page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await openSyncDetails(iphone.page);
  await syncNow(iphone.page);
  await expect(syncStatusLine(iphone.page)).toHaveText(/^À jour/);
  const newId = (await inspect(room, 'iphone')).deviceId;
  expect(newId).not.toBe(iphoneId);
  await syncAll([pc, iphone, pc]);
  // Le PC voit l'ancien iPhone oublié et le nouveau actif, sans bouton d'oubli sur l'ancien.
  await expect(pc.page.getByRole('listitem').filter({ hasText: 'Oublié' })).toHaveCount(1);
  await expect(pc.page.getByRole('button', { name: /^Oublier iPhone/ })).toHaveCount(1);
});
