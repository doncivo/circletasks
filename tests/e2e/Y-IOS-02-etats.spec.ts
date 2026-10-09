import { expect, test, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from './helpers/app';
import { expectFitsViewport } from './helpers/layout';
import { closeRoom, openPairingWindow, openSyncDetails, openSyncedPage, openTasks, propagate, setTesting, syncNow, type SyncedPage } from './helpers/sync';

/**
 * Y-IOS-02, QA du parcours d'association (demande d'Ali, 0.2.2) : états d'association qui ne demandent qu'un appareil, sur le simulateur de
 * dossier. Projet `iphone` (440 × 956, agent iOS posé par `openSyncedPage`) : iPhone sans clé qui voudrait « commencer une nouvelle
 * synchronisation », Trousseau verrouillé puis déverrouillé. Projet `pc` : PC sans clé (association par la clé de secours erronée puis
 * juste), refus de la confirmation, application pas au premier plan, fenêtre déjà ouverte, coffre de Windows verrouillé. À chaque fois :
 * un texte juste, l'action utile, aucune action inutile ou dangereuse.
 */

const SHOW_QR = 'Associer l’iPhone : afficher le code d’association';
const ASSOCIATE_PC = 'Associer cet iPhone au PC : scanner le code d’association';
const ASSOCIATE_THIS = 'Associer cet appareil avec la clé de secours';
const RESET = 'Réinitialiser la synchronisation avec une nouvelle clé';
const START_NEW = 'Commencer une nouvelle synchronisation sur cet iPhone';
const REREAD = 'Relire l’état du dossier de synchronisation';
const FORGET = 'Oublier le dossier de synchronisation';

const BUDGET_MS = 60_000;

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

const reglages = (page: Page) => page.getByRole('navigation').getByText('Réglages', { exact: true });
const syncNowButton = (page: Page) => page.getByRole('button', { name: 'Synchroniser', exact: true });

/** Passage en arrière-plan puis retour au premier plan : les écrans relisent, un cycle d'ouverture est lancé. */
async function backgroundThenForeground(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** Accueil de Réglages (l'onglet rouvre le dernier écran visité : les détails de la synchro, d'où « Retour à Réglages »). */
async function openSettingsHome(page: Page): Promise<void> {
  await reglages(page).click();
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  if (((await heading.textContent()) ?? '').trim() === 'Synchronisation') await page.getByRole('button', { name: 'Retour à Réglages' }).click();
}

/** PC (premier appareil) qui a synchronisé une fois, dossier propagé. */
async function firstPc(browser: Parameters<typeof openSyncedPage>[0]): Promise<SyncedPage> {
  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);
  return pc;
}

test('Y-IOS-02 QA : iPhone sans clé, « Commencer une nouvelle synchronisation » refusé (le dossier a des données), l’association reste proposée', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02e1-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  await firstPc(browser);
  const phone = await openSyncedPage(browser, room, 'iphone', 'bare', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await reglages(page).click();
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: START_NEW })).toBeVisible();
  await expect(syncNowButton(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: SHOW_QR })).toHaveCount(0);
  await expectFitsViewport(page, 'Réglages › Synchronisation, sans clé');

  // « Commencer » : la confirmation dit le risque ; annulée, rien ne change.
  await page.getByRole('button', { name: START_NEW }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expectFitsViewport(page, 'Confirmation de la nouvelle synchronisation');
  await confirm.getByRole('button', { name: 'Annuler' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('sync-start-notice')).toHaveCount(0);

  // Confirmée : Rust refuse (le dossier contient des données), le dit ; l'association reste la seule issue, aucune clé créée.
  await page.getByRole('button', { name: START_NEW }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Commencer quand même' }).click();
  await expect(page.getByTestId('sync-start-notice')).toHaveText('Ce dossier contient déjà des données chiffrées : associez cet appareil');
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toBeVisible();
  await expect(syncNowButton(page)).toHaveCount(0);
  await expect(page.locator('.ct-status-banner').filter({ hasText: 'Associez cet iPhone au PC pour synchroniser' })).toBeVisible();
  await expectFitsViewport(page, 'Réglages › Synchronisation, nouvelle synchronisation refusée');
});

test('Y-IOS-02 QA : iPhone associé, Trousseau verrouillé puis déverrouillé : texte de l’iPhone, relire, rien de destructeur', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02e2-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  await firstPc(browser);
  const phone = await openSyncedPage(browser, room, 'iphone', 'join', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await openSyncDetails(page);
  await syncNow(page);

  await setTesting(room, 'iphone', 'setVaultAvailable', false);
  await backgroundThenForeground(page);
  const banner = page.locator('.ct-status-banner');
  await expect(banner.filter({ hasText: 'Le Trousseau de l’iPhone est indisponible : déverrouillez l’iPhone, la synchro reprendra' })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  // Clé illisible : ni réinitialisation ni association devinée, « Synchroniser » relit.
  await expect(page.getByRole('button', { name: RESET })).toHaveCount(0);
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toHaveCount(0);
  await expect(syncNowButton(page)).toBeVisible();
  await expectFitsViewport(page, 'Détails, Trousseau verrouillé');
  await openSettingsHome(page);
  await expect(page.getByText('Le Trousseau de l’iPhone est indisponible : déverrouillez l’iPhone, la synchro reprendra').first()).toBeVisible();
  await expect(page.getByRole('button', { name: REREAD })).toBeVisible();
  await expect(page.getByRole('button', { name: FORGET })).toBeVisible();
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toHaveCount(0);
  await expectFitsViewport(page, 'Réglages › Synchronisation, Trousseau verrouillé');

  // Déverrouillé : « Relire » rétablit la ligne normale sans autre geste.
  await setTesting(room, 'iphone', 'setVaultAvailable', true);
  await page.getByRole('button', { name: REREAD }).click();
  await expect(page.getByRole('button', { name: 'Détails', exact: true })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByText('Le Trousseau de l’iPhone est indisponible', { exact: false })).toHaveCount(0);
  await expectFitsViewport(page, 'Réglages › Synchronisation, Trousseau déverrouillé');
});

test('Y-IOS-02 QA : PC sans clé, association par la clé de secours : erronée dite, bonne acceptée ; Détails sans « Réinitialiser » ni « Synchroniser »', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'PC seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02e3-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const first = await firstPc(browser);
  // Clé de secours affichée par le premier PC.
  await reglages(first.page).click();
  await first.page.getByRole('button', { name: SHOW_QR }).click();
  const show = await openPairingWindow(first.context, room, 'pc');
  await expect(show.getByTestId('pairing-recovery-key')).toHaveText(/^CT1(-[0-9A-Z]{5})+$/, { timeout: APP_READY_TIMEOUT_MS });
  const recoveryKey = (await show.getByTestId('pairing-recovery-key').textContent()) ?? '';
  await show.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }).click();
  await show.close();
  await propagate(room);

  const second = await openSyncedPage(browser, room, 'pc2', 'bare', 'pc');
  opened.push(second);
  const page = second.page;
  await reglages(page).click();
  await expect(page.getByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: ASSOCIATE_THIS })).toBeVisible();
  await expect(page.getByRole('button', { name: SHOW_QR })).toHaveCount(0);
  await expect(syncNowButton(page)).toHaveCount(0);

  // Détails (par le bandeau) : l'association seulement.
  await page.locator('.ct-status-banner').filter({ hasText: 'Associez cet appareil pour synchroniser' }).locator('.ct-status-banner__action').click();
  await expect(page.getByRole('heading', { name: 'Synchronisation', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: ASSOCIATE_THIS })).toBeVisible();
  await expect(page.getByRole('button', { name: RESET })).toHaveCount(0);
  await expect(page.getByRole('button', { name: SHOW_QR })).toHaveCount(0);
  await expect(syncNowButton(page)).toHaveCount(0);
  await expect(page.getByTestId('sync-devices-empty')).toHaveText('Associez cet appareil pour voir les autres appareils');
  await openSettingsHome(page);

  // Fenêtre de saisie : clé erronée dite, saisie vidée ; la bonne clé associe.
  await page.getByRole('button', { name: ASSOCIATE_THIS }).click();
  const entry = await openPairingWindow(second.context, room, 'pc2');
  const field = entry.getByLabel('Clé de secours');
  await expect(field).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await field.fill('CT1-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG');
  await entry.getByRole('button', { name: 'Associer', exact: true }).click();
  await expect(entry.getByTestId('pairing-import-message')).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(entry.getByRole('button', { name: 'Associer', exact: true })).toBeEnabled();
  await field.fill(recoveryKey);
  await entry.getByRole('button', { name: 'Associer', exact: true }).click();
  await expect(entry.getByText('Cet appareil est associé')).toBeVisible();
  await entry.close();

  // Associé : dans l'app installée, `sync-paired` (Rust) rafraîchit la ligne ; le navigateur de dev n'a pas cet événement, on quitte puis
  // on rouvre Réglages (la ligne relit la clé, présente).
  await openTasks(page);
  await reglages(page).click();
  await expect(page.getByRole('button', { name: ASSOCIATE_THIS })).toHaveCount(0, { timeout: APP_READY_TIMEOUT_MS });
  await openSyncDetails(page);
  await syncNow(page);
  await expect(page.getByRole('button', { name: RESET })).toBeVisible();
});

test('Y-IOS-02 QA : PC, « Associer l’iPhone » : confirmation refusée, application en arrière-plan, fenêtre déjà ouverte : chaque message est dit, le bouton reste', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'PC seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02e4-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const pc = await firstPc(browser);
  const page = pc.page;
  await openSettingsHome(page);
  const show = page.getByRole('button', { name: SHOW_QR });
  await expect(show).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  const notice = page.getByTestId('sync-pairing-notice');

  // Application pas au premier plan : dit, rien n'est ouvert ni compté.
  await setTesting(room, 'pc', 'setForeground', false);
  await show.click();
  await expect(notice).toHaveText('Revenez dans l’application et réessayez');
  await expect(show).toBeEnabled();

  // Au premier plan : la fenêtre s'ouvre (aucun message) ; une seconde demande le dit, sans rien casser.
  await setTesting(room, 'pc', 'setForeground', true);
  await show.click();
  await expect(notice).toHaveCount(0);
  await expect(show).toBeEnabled();
  await show.click();
  await expect(notice).toHaveText('La fenêtre d’association est déjà ouverte');
  await expect(show).toBeEnabled();

  // Fenêtre fermée, confirmation refusée : « Affichage annulé » ; le blocage de 10 minutes qui suit est dit aussi (jamais un bouton muet).
  const window = await openPairingWindow(pc.context, room, 'pc');
  await window.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }).click();
  await window.close();
  await setTesting(room, 'pc', 'setConsent', false);
  await show.click();
  await expect(notice).toHaveText('Affichage annulé');
  await expect(show).toBeEnabled();
  await show.click();
  await expect(notice).toHaveText('Trop de demandes : réessayez dans 10 minutes');
  await expect(show).toBeEnabled();
});

test('Y-IOS-02 QA : PC, coffre de Windows verrouillé puis rétabli : texte du coffre, relire, aucune association devinée', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'PC seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02e5-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const pc = await firstPc(browser);
  const page = pc.page;
  await openSettingsHome(page);
  await expect(page.getByRole('button', { name: 'Détails', exact: true })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });

  await setTesting(room, 'pc', 'setVaultAvailable', false);
  await backgroundThenForeground(page);
  await expect(page.getByText('Le coffre de Windows est indisponible').first()).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: REREAD })).toBeVisible();
  await expect(page.getByRole('button', { name: FORGET })).toBeVisible();
  await expect(page.getByRole('button', { name: ASSOCIATE_THIS })).toHaveCount(0);

  await setTesting(room, 'pc', 'setVaultAvailable', true);
  await page.getByRole('button', { name: REREAD }).click();
  await expect(page.getByRole('button', { name: 'Détails', exact: true })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: SHOW_QR })).toBeVisible();
});
