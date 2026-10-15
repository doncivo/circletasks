import { expect, test, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from '../helpers/app';
import { closeRoom, inspect, openSyncDetails, openSyncedPage, propagate, setTesting, syncNow, syncStatusLine, type SyncedPage } from '../helpers/sync';

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

/**
 * Budget de Y-10-FIX-01 : deux apps démarrées, quatre cycles, trois demandes d'oubli. Durées mesurées le 2026-10-15 (serveur de dev déjà
 * compilé, processeur occupé de 87 à 100 % par d'autres suites) : 26,0 à 39,3 s sur pc, 27,2 à 30,3 s sur iphone ; pire mesuré
 * 39,3 s (pc) ; budget 70 s, près du double de ce pire (consigne d'Ali : ni `test.slow()` ni nouvel essai).
 */
const CANCEL_BUDGET_MS = 70_000;

/**
 * Y-10-FIX-01 (cas réel de la séance iPhone 0.3.0) : la boîte native refusée, le nouvel essai rendu « trop de demandes » (blocage de
 * 10 minutes de Rust, joué par la plateforme mémoire du simulateur) ; « Annuler la demande » efface la ligne rouge et le bandeau sans
 * rien déclencher. Lancé sur les deux projets : sur `pc`, le PC oublie l'iPhone ; sur `iphone`, l'iPhone oublie le PC.
 *
 * Le redémarrage n'est pas rejoué ici : le navigateur de dev garde la base en mémoire (vide au rechargement, voir l'en-tête) ; la
 * persistance dans `sync_meta` est prouvée par simulation (`tests/unit/sync/forget/forgetCancel.test.ts`, redémarrage du service).
 */
test('Y-10-FIX-01 : oubli en échec (trop de demandes), « Annuler la demande » efface la ligne et le bandeau sans rien déclencher', async ({ browser }) => {
  const info = test.info();
  test.setTimeout(CANCEL_BUDGET_MS);
  room = `y10fix-${info.project.name}-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const onPhone = info.project.name === 'iphone';

  const pc = await openSyncedPage(browser, room, 'pc', 'first');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);
  const iphone = await openSyncedPage(browser, room, 'iphone', 'join');
  opened.push(iphone);
  await openSyncDetails(iphone.page);
  await syncAll([iphone, pc, iphone]);

  const [actor, actorName, target] = onPhone ? ([iphone, 'iphone', 'PC'] as const) : ([pc, 'pc', 'iPhone'] as const);
  const page = actor.page;
  const row = deviceRow(page, new RegExp(`^${target}`));
  const forgetButton = row.getByRole('button', { name: new RegExp(`^Oublier ${target}`) });
  const forgetZone = page.locator('.ct-sync__forget[role="status"]');
  const failedLine = forgetZone.locator('[data-failed="true"]');
  const retry = page.getByRole('button', { name: new RegExp(`^Réessayer d’oublier ${target}`) });
  const cancel = page.getByRole('button', { name: new RegExp(`^Annuler la demande d’oubli de ${target}`) });
  const dialog = page.getByRole('alertdialog', { name: new RegExp(`^Oublier ${target}`) });

  // La veille : « Oublier », « Continuer », boîte native refusée (rien n'est écrit, blocage de 10 minutes chez Rust).
  await setTesting(room, actorName, 'setConsent', false);
  await forgetButton.click();
  await dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(row.getByRole('status')).toHaveText('Oubli annulé', { timeout: APP_READY_TIMEOUT_MS });
  await expect(failedLine).toHaveCount(0);

  // Nouvel essai aussitôt : « trop de demandes » ; ligne rouge avec « Réessayer » et « Annuler la demande » (critère 1).
  await setTesting(room, actorName, 'setConsent', true);
  await forgetButton.click();
  await dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(failedLine).toContainText(`L’oubli de ${target}`, { timeout: APP_READY_TIMEOUT_MS });
  await expect(failedLine).toContainText('trop de demandes, réessayez dans 10 minutes');
  await expect(failedLine.getByRole('button')).toHaveText(['Réessayer', 'Annuler la demande']);
  // Bandeau A-09 de l'échec, depuis l'écran principal comme dans Réglages.
  const bannerButton = page.getByRole('button', { name: 'Voir le problème de synchronisation' });
  await expect(bannerButton).toBeVisible();

  // Critère 8 : un appui sur le texte rouge ou sur la ligne ne fait rien.
  await failedLine.locator('[data-trouble="true"]').click();
  await failedLine.getByText(/^Dernier essai/).click();
  await expect(dialog).toHaveCount(0);
  await expect(failedLine).toHaveCount(1);

  // Critère 10 : « Réessayer » repasse par la boîte de l'app ; « Annuler » (par défaut) : rien ne part.
  await retry.click();
  await expect(dialog).toContainText('L’oubli ne s’annule pas');
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Annuler' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(failedLine).toHaveCount(1);

  // Critères 3 et 5 : « Annuler la demande » : ligne et bandeau disparus, « Demande annulée », aucune boîte.
  await cancel.click();
  await expect(failedLine).toHaveCount(0);
  await expect(forgetZone).toContainText('Demande annulée');
  await expect(forgetZone).toBeFocused();
  await expect(dialog).toHaveCount(0);
  await expect(bannerButton).toHaveCount(0);

  // Un cycle ne la fait pas revenir ; l'appareil n'est pas oublié.
  await syncNow(page);
  await expect(failedLine).toHaveCount(0);
  await expect(row.getByText('Oublié', { exact: true })).toHaveCount(0);
  await expect(forgetButton).toBeVisible();

  // Critère 7 : le blocage de 10 minutes n'est pas levé : un nouvel oubli redonne « trop de demandes », la ligne revient avec ses deux boutons.
  await forgetButton.click();
  await dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(failedLine).toContainText('trop de demandes, réessayez dans 10 minutes', { timeout: APP_READY_TIMEOUT_MS });
  await expect(failedLine.getByRole('button')).toHaveText(['Réessayer', 'Annuler la demande']);
  await expect(forgetZone).not.toContainText('Demande annulée');
});
