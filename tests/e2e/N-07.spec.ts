import { expect, test, type Browser, type Page } from '@playwright/test';
import { openApp } from './helpers/app';
import { closeRoom, openSyncDetails, openSyncedPage, openTasks, propagate, syncNow, type SyncedPage } from './helpers/sync';
import { createTask, isPhone } from './helpers/today';

/**
 * N-07 — Un rappel créé sur le PC sonne sur l'iPhone : avertissement du PC (il ne planifie rien, il AVERTIT).
 *
 * Sans iPhone associé : « Aucun iPhone associé : ce rappel ne sonnera pas » dans la ligne « Rappels » du détail et dans Réglages > Rappels
 * (nombre de rappels des 2 prochaines heures). Avec un iPhone simulé (`__ctSyncSim`, plateforme `ios`) qui vient de se synchroniser :
 * aucun avertissement ; trois heures plus tard sur l'horloge du PC (l'iPhone n'a rien publié depuis) : « L'iPhone ne s'est pas synchronisé
 * depuis plus de 2 h ». La disparition à la synchro suivante de l'iPhone (phase suivante de SyncStatus), les bornes (1 h 59, 2 h 00,
 * 2 h 30), les états `forgotten`, `expired`, `corrupt`, la minuterie d'une minute et l'iPhone sans avertissement sont vérifiés en Vitest
 * (la valeur publiée par l'iPhone n'est rafraîchie qu'au plus toutes les 30 minutes). Projet `pc` seulement, sauf le contrôle `iphone`.
 */
const TITLE = 'Appeler le notaire';

const detail = (page: Page) => page.getByRole('complementary', { name: 'Détail de la tâche' }).or(page.getByRole('dialog', { name: 'Détail de la tâche' }));

/** Date et heure locales du navigateur dans `minutes` minutes (fuseau simulé de Playwright). */
async function inMinutes(page: Page, minutes: number): Promise<{ date: string; time: string }> {
  return page.evaluate((delta) => {
    const d = new Date(Date.now() + delta * 60_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }, minutes);
}

async function createSoon(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  // Espace Perso : sans plage silencieuse (Pro décale les rappels de 20:00 à 08:00, l'échéance effective sortirait de la fenêtre de 2 h la nuit).
  await page.getByRole('group', { name: 'Filtre d’espace' }).getByRole('button', { name: 'Perso' }).click();
  const soon = await inMinutes(page, 30);
  const today = (await inMinutes(page, 0)).date;
  await createTask(page, testInfo, { title: TITLE, time: soon.time, ...(soon.date === today ? {} : { date: soon.date }) });
  await page.locator('.ct-list-row').filter({ has: page.getByRole('button', { name: TITLE, exact: true }) }).getByRole('button', { name: TITLE, exact: true }).click();
}

let opened: SyncedPage[] = [];
let room = '';

test.afterEach(async () => {
  await Promise.all(opened.map((p) => p.context.close()));
  opened = [];
  if (room) await closeRoom(room);
  room = '';
});

test.describe('N-07 — avertissement du PC', () => {
  test('sans iPhone associé : « Aucun iPhone associé : ce rappel ne sonnera pas » (critères 6 et 7)', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo), 'Avertissement du PC : projet pc seulement.');
    await openApp(page);
    await createSoon(page, testInfo);
    await expect(detail(page).getByText('Aucun iPhone associé : ce rappel ne sonnera pas')).toBeVisible();
    // Réglages > Rappels : le nombre de rappels concernés dans les 2 prochaines heures.
    await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
    await page.getByRole('button', { name: /^Récapitulatifs :/ }).click();
    await expect(page.getByText('Les rappels sont envoyés par l’iPhone')).toBeVisible();
    await expect(page.getByText('Aucun iPhone associé : 1 rappel dans les 2 prochaines heures ne sonnera pas')).toBeVisible();
  });

  test.describe('avec l’agent d’un iPhone', () => {
    test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    test('sur l’iPhone, aucun avertissement N-07 (critère 9)', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'Contrôle du projet iphone.');
    await openApp(page);
    await createSoon(page, testInfo);
    await expect(detail(page).getByText('Rappels')).toBeVisible();
    await expect(page.getByText(/Aucun iPhone associé|ne s’est pas synchronisé/)).toHaveCount(0);
    });
  });

  test('iPhone simulé synchronisé : aucun avertissement ; 3 h plus tard sur le PC sans nouvelle synchro de l’iPhone : « pourrait ne pas sonner à l’heure » (critères 4, 5, 10)', async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'pc', 'lancé une fois, depuis le projet pc');
    test.setTimeout(60_000);
    room = `n07-${String(testInfo.workerIndex)}-${testInfo.testId}-${String(testInfo.repeatEachIndex)}`;
    const pc = await startPair(browser, room);
    opened.push(pc.pc, pc.iphone);

    // L'iPhone vient de publier son état : un rappel dans 30 minutes n'avertit pas.
    await openTasks(pc.pc.page);
    await createSoon(pc.pc.page, { project: { name: 'pc' } });
    await expect(detail(pc.pc.page).getByText('Rappels')).toBeVisible();
    await expect(pc.pc.page.getByText(/Aucun iPhone associé|ne s’est pas synchronisé/)).toHaveCount(0);

    // L'horloge du PC avance de 3 h : l'iPhone n'a rien publié depuis (sa valeur publiée a 3 h) ; un rappel proche avertit.
    await pc.pc.page.clock.install({ time: new Date() });
    await pc.pc.page.clock.fastForward('03:00:00');
    await pc.pc.page.keyboard.press('Escape');
    const later = await inMinutes(pc.pc.page, 30);
    await openTasks(pc.pc.page);
    await createTask(pc.pc.page, { project: { name: 'pc' } }, { title: 'Dans une demi-heure', time: later.time, ...(later.date === (await inMinutes(pc.pc.page, 0)).date ? {} : { date: later.date }) });
    await pc.pc.page.getByRole('button', { name: 'Dans une demi-heure', exact: true }).click();
    await expect(detail(pc.pc.page).getByText('L’iPhone ne s’est pas synchronisé depuis plus de 2 h : ce rappel pourrait ne pas sonner à l’heure')).toBeVisible();
  });
});

/** PC premier appareil (dossier et clé), iPhone simulé associé : tous deux ont synchronisé, le PC a lu l'état publié de l'iPhone. */
async function startPair(browser: Browser, roomName: string): Promise<{ pc: SyncedPage; iphone: SyncedPage }> {
  const pc = await openSyncedPage(browser, roomName, 'pc', 'first');
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  await propagate(roomName);
  const iphone = await openSyncedPage(browser, roomName, 'iphone', 'join');
  await openSyncDetails(iphone.page);
  await syncNow(iphone.page);
  await propagate(roomName);
  await openSyncDetails(pc.page);
  await syncNow(pc.page);
  return { pc, iphone };
}
