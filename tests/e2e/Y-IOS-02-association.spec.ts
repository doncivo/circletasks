import { expect, test, type Page } from '@playwright/test';
import { APP_READY_TIMEOUT_MS } from './helpers/app';
import { closeRoom, openSyncDetails, openSyncedPage, propagate, syncNow, type SyncedPage } from './helpers/sync';

/**
 * Y-IOS-02, point de contrôle d'Ali (IPA 0.2.1) : simulateur de dossier.
 * - iPhone (projet `iphone`) : dossier du PC choisi, sans clé : après les cycles (ouverture, retour au premier plan), « Associer au PC »
 *   reste proposé dans Réglages › Synchronisation et dans Détails (atteint par le bandeau), le bandeau dit d'associer l'iPhone, ni
 *   « Synchroniser » ni « Réinitialiser » ; APPAREILS expliqué. Détails sans défilement horizontal, titre entier visible (440 × 956).
 * - PC (projet `pc`) : « Associer l'iPhone » directement dans Réglages › Synchronisation (chemin dit par l'iPhone), et dans Détails.
 */

const ASSOCIATE_PC = 'Associer cet iPhone au PC : scanner le code d’association';
const SHOW_QR = 'Associer l’iPhone : afficher le code d’association';
const BANNER = 'Associez cet iPhone au PC pour synchroniser';

/** Budget : deux apps démarrées et quelques cycles (même mesure que Y-IOS-02.spec.ts) ; sans `test.slow()` ni nouvel essai. */
const BUDGET_MS = 40_000;

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

/** Aucune largeur au-delà de l'écran, titre « Synchronisation » entier dans la fenêtre. */
async function expectFitsWidth(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return { scroll: root.scrollWidth, client: root.clientWidth };
  });
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
  const title = page.getByRole('heading', { name: 'Synchronisation', level: 1 });
  await expect(title).toBeVisible();
  const box = await title.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  // Le texte n'est pas rogné : sa largeur de contenu tient dans sa boîte.
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
}

test('Y-IOS-02 : iPhone sans clé, « Associer au PC » toujours proposé après les cycles, Détails sans débordement', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02a-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;

  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(room);

  const phone = await openSyncedPage(browser, room, 'iphone', 'bare', 'iphone');
  opened.push(phone);
  const page = phone.page;
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  const banner = page.locator('.ct-status-banner').filter({ hasText: BANNER });
  await expect(banner).toBeVisible();

  // Passage en arrière-plan puis retour : cycle d'ouverture ; l'état reste « à associer ».
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toBeVisible();
  await expect(page.getByText('Ce dossier contient déjà des données chiffrées : associez cet appareil')).toBeVisible();
  await expect(page.getByText('La synchronisation a échoué : nouvel essai au prochain cycle')).toHaveCount(0);

  // Détails (par le bandeau) : association seulement.
  await banner.locator('.ct-status-banner__action').click();
  await expect(page.getByRole('heading', { name: 'Synchronisation', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: ASSOCIATE_PC })).toBeVisible();
  await expect(page.getByTestId('sync-status-text')).toHaveText(BANNER);
  await expect(page.getByRole('button', { name: 'Synchroniser', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toHaveCount(0);
  await expect(page.getByTestId('sync-devices-empty')).toHaveText('Associez cet iPhone pour voir les autres appareils');
  await expect(page.getByRole('img', { name: /QR/ })).toHaveCount(0);
  await expectFitsWidth(page);
});

test('Y-IOS-02 : iPhone associé, Détails sans débordement horizontal, titre entier', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'iphone', 'iPhone seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02b-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const phone = await openSyncedPage(browser, room, 'iphone', 'first', 'iphone');
  opened.push(phone);
  await openSyncDetails(phone.page);
  await syncNow(phone.page);
  await expect(phone.page.getByRole('button', { name: 'Réinitialiser la synchronisation avec une nouvelle clé' })).toBeVisible();
  await expectFitsWidth(phone.page);
});

test('Y-IOS-02 : PC, « Associer l’iPhone » directement dans Réglages › Synchronisation, et dans Détails', async ({ browser }) => {
  const info = test.info();
  test.skip(info.project.name !== 'pc', 'PC seulement');
  test.setTimeout(BUDGET_MS);
  room = `yios02c-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
  const pc = await openSyncedPage(browser, room, 'pc', 'first', 'pc');
  opened.push(pc);
  const page = pc.page;
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Détails', exact: true })).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  await expect(page.getByRole('button', { name: SHOW_QR })).toBeVisible();
  await expect(page.getByRole('button', { name: SHOW_QR })).toHaveCount(1);
  await page.getByRole('button', { name: 'Détails', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Synchronisation', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: SHOW_QR })).toBeVisible();
});
