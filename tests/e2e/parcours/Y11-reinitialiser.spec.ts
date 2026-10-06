import { expect, test, type Browser, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from '../helpers/app';
import { closeRoom, openPairingWindow, openSyncDetails, openSyncedPage, propagate, syncNow, type SyncedPage } from '../helpers/sync';

/**
 * Y-11 « Je réinitialise la synchronisation avec une nouvelle clé » (ADR 0011 §14.3 ; fiche Y-11, critères 1, 7, 8, 10, 12, 13, 17 et
 * 18 ; vérification manuelle 7) sur deux pages du navigateur de dev reliées par le simulateur de dossier (`tests/sim/syncFolderSim.ts`,
 * rôle de Rust : confirmations natives acceptées, `K2` sous `.next`, annonce, bascule). Lancé une fois, depuis le projet `pc` (`--headed`
 * pour relire les écrans composés, sans maquette).
 */

let opened: SyncedPage[] = [];
let room = '';

/**
 * Budget : deux apps démarrées, deux fenêtres `pairing`, une quinzaine de cycles. Durée mesurée le 2026-10-06 (projet pc, 2 workers,
 * `--repeat-each` 2 et 3, serveur de dev déjà compilé) : 13,0 à 18,0 s ; budget 50 s, plus du double du pire mesuré (consigne d'Ali : ni
 * `test.slow()` ni nouvel essai).
 */
const PARCOURS_BUDGET_MS = 50_000;

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

const resetSlot = (page: Page) => page.getByTestId('sync-reset');

/** Clé de secours affichée par la fenêtre `pairing` ouverte depuis « Associer l'iPhone » ou « Afficher la nouvelle clé de secours ». */
async function recoveryKeyShown(owner: SyncedPage, open: () => Promise<void>): Promise<string> {
  await open();
  const show = await openPairingWindow(owner.context, room, 'pc');
  const key = show.getByTestId('pairing-recovery-key');
  await expect(key).toHaveText(/^CT1(-[0-9A-Z]{5})+$/, { timeout: APP_READY_TIMEOUT_MS });
  const text = (await key.textContent()) ?? '';
  await show.getByRole('button', { name: 'Annuler et fermer la fenêtre d’association' }).click();
  await show.close();
  return text;
}

async function twoPcs(browser: Browser, info: ReturnType<typeof test.info>, name: string): Promise<[SyncedPage, SyncedPage]> {
  room = `${name}-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const pc = await openSyncedPage(browser, room, 'pc', 'first');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);
  const pc2 = await openSyncedPage(browser, room, 'pc2', 'join', 'pc');
  opened.push(pc2);
  await openSyncDetails(pc2.page);
  for (const p of [pc2, pc, pc2, pc]) {
    await propagate(room);
    await syncNow(p.page);
  }
  return [pc, pc2];
}

/** « Réinitialiser la synchronisation » : boîte de l'app expliquée, « Annuler » par défaut, puis « Continuer ». */
async function startReset(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' });
  await button.click();
  const dialog = page.getByRole('alertdialog', { name: 'Réinitialiser la synchronisation ?' });
  await expect(dialog).toContainText('L’ancienne clé de secours ne servira plus');
  await expect(dialog).toContainText('conservées et fusionnées');
  await expect(dialog).toContainText('30 jours dans « Supprimés récemment » d’iCloud');
  await expect(dialog.getByRole('button', { name: 'Annuler' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(resetSlot(page).getByText('Nouvelle clé créée.')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
}

test('Y-11 : réinitialiser depuis le PC, le second PC doit être associé de nouveau, il s’associe avec la nouvelle clé, bascule partout', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'lancé une fois, depuis le projet pc');
  test.setTimeout(PARCOURS_BUDGET_MS);
  const [pc, pc2] = await twoPcs(browser, info, 'y11');

  // Ancienne clé de secours (Y-06), pour vérifier qu'elle ne sert plus.
  const oldKey = await recoveryKeyShown(pc, () => pc.page.getByRole('button', { name: 'Associer l’iPhone : afficher le code d’association' }).click());

  // Critère 1 : explication, « Annuler » par défaut, Échap annule ; puis la réinitialisation est lancée.
  await pc.page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' }).click();
  await expect(pc.page.getByRole('alertdialog')).toBeVisible();
  await pc.page.keyboard.press('Escape');
  await expect(pc.page.getByRole('alertdialog')).toHaveCount(0);
  await startReset(pc.page);
  // Critères 13 et 17 : étape en clair, liste des appareils à associer (nom, dernière synchro, « Oublier cet appareil »).
  await expect(resetSlot(pc.page)).toContainText('Réinitialisation : en attente d’un appareil');
  const waiting = pc.page.getByTestId('sync-reset-waiting');
  await expect(waiting.getByRole('listitem')).toHaveCount(1);
  await expect(waiting.getByRole('button', { name: /^Oublier PC/ })).toBeVisible();
  // Bandeau A-09 depuis l'écran principal tant que la transition n'est pas terminée.
  await expect(pc.page.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeVisible();

  // Critère 7 (D1) : la nouvelle clé de secours (K2), jamais l'ancienne.
  await expect(pc.page.getByText('L’ancienne clé de secours ne sert plus. Affichez la nouvelle, imprimez-la, puis détruisez l’ancienne feuille.')).toBeVisible();
  const newKey = await recoveryKeyShown(pc, () => pc.page.getByRole('button', { name: 'Afficher et imprimer la nouvelle clé de secours' }).click());
  expect(newKey).not.toBe(oldKey);

  // Critère 8 : le second PC lit l'annonce authentique : « Cet appareil doit être associé de nouveau », publication suspendue.
  await propagate(room);
  await syncNow(pc2.page, /^Cet appareil doit être associé de nouveau$/);
  await expect(resetSlot(pc2.page)).toContainText('Cet appareil doit être associé de nouveau');
  await expect(pc2.page.getByRole('button', { name: 'Voir le problème de synchronisation' })).toBeVisible();
  // Critère 10 : « Associer cet appareil » (fenêtre pairing, clé de secours) avec la nouvelle clé ; l'ancienne est refusée.
  await pc2.page.getByRole('button', { name: 'Associer cet appareil avec la clé de secours' }).click();
  const entry = await openPairingWindow(pc2.context, room, 'pc2');
  const field = entry.getByLabel('Clé de secours');
  await expect(field).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await field.fill(newKey);
  await entry.getByRole('button', { name: 'Associer', exact: true }).click();
  await expect(entry.getByText('Cet appareil est associé')).toBeVisible();
  await entry.close();
  await openSyncDetails(pc2.page);
  await syncNow(pc2.page);
  await expect(resetSlot(pc2.page)).toContainText('Associé avec la nouvelle clé');

  // Critère 12 : le PC bascule (le second PC est réassocié), puis le second PC.
  await propagate(room);
  await syncNow(pc.page);
  await expect(resetSlot(pc.page)).toContainText('Réinitialisation terminée : l’ancienne clé est effacée');
  await propagate(room);
  await syncNow(pc2.page);
  await expect(resetSlot(pc2.page)).toContainText('Réinitialisation terminée');
  await pc.page.getByRole('button', { name: 'Fermer le message de réinitialisation terminée' }).click();
  await expect(pc.page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeVisible();
  await expect(pc.page.getByRole('button', { name: 'Voir le problème de synchronisation' })).toHaveCount(0);
});

test('Y-11 : « Oublier cet appareil » est le seul moyen de terminer sans le second PC', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'lancé une fois, depuis le projet pc');
  test.setTimeout(PARCOURS_BUDGET_MS);
  const [pc] = await twoPcs(browser, info, 'y11-oubli');
  await startReset(pc.page);
  const waiting = pc.page.getByTestId('sync-reset-waiting');
  await waiting.getByRole('button', { name: /^Oublier PC/ }).click();
  const dialog = pc.page.getByRole('alertdialog', { name: /^Oublier PC/ });
  await dialog.getByRole('button', { name: 'Continuer' }).click();
  await expect(resetSlot(pc.page)).toContainText('Réinitialisation terminée', { timeout: APP_READY_TIMEOUT_MS });
  await expect(pc.page.getByTestId('sync-reset-waiting')).toHaveCount(0);
});
