import { expect, test, type Page } from '@playwright/test';
import { openApp, waitForScreenLoaded } from './helpers/app';
import { closeRoom, openSyncDetails, openSyncedPage, type SyncedPage } from './helpers/sync';

/**
 * Titres des écrans iPhone sur UNE ligne (défaut vu par Ali sur l'iPhone en 0.2.3 : « Synchronisation » des Détails sur deux lignes).
 * Le contrôle précédent (Y-IOS-02-association) vérifiait seulement que le titre ne dépassait pas : avec `overflow-wrap: anywhere`, un
 * titre trop grand passe à la ligne au milieu du mot sans jamais dépasser, et le test restait vert. Ici : polices embarquées réellement
 * chargées (Fraunces), puis une seule ligne de texte (rectangles du texte sur une même ligne, hauteur = une hauteur de ligne), sans
 * débordement, aux largeurs 440 (iPhone 16 Pro Max), 430 et 375 points. Projets `iphone` (Chromium) et `iphone-webkit` (WebKit).
 */

const WIDTHS = [440, 430, 375] as const;

/** Attend que les polices embarquées soient chargées (jamais une mesure avec la police de repli) et le vérifie. */
async function fontsReady(page: Page): Promise<void> {
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('700 40px "Fraunces Variable"', 'Synchronisation');
    await document.fonts.ready;
    return Array.from(document.fonts).some((face) => face.family.replace(/"/g, '') === 'Fraunces Variable' && face.status === 'loaded');
  });
  expect(loaded, 'police Fraunces embarquée non chargée').toBe(true);
}

interface TitleMetrics {
  readonly text: string;
  readonly lines: number;
  readonly height: number;
  readonly lineHeight: number;
  readonly fontSize: number;
  readonly overflow: boolean;
  readonly right: number;
  readonly textWidth: number;
  readonly boxWidth: number;
  readonly viewport: number;
}

/** Mesure le titre `h1` visible : nombre de lignes de texte, hauteur, hauteur de ligne, débordement. */
async function measureTitle(page: Page): Promise<TitleMetrics> {
  const title = page.getByRole('heading', { level: 1 }).first();
  await expect(title).toBeVisible();
  return title.evaluate((el) => {
    const style = getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize);
    const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.2 : parseFloat(style.lineHeight);
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    // Une ligne = des rectangles dont les milieux verticaux se recouvrent ; un passage à la ligne en ajoute une autre.
    const middles: number[] = [];
    for (const rect of rects) {
      const middle = rect.top + rect.height / 2;
      if (!middles.some((known) => Math.abs(known - middle) < lineHeight / 2)) middles.push(middle);
    }
    const box = el.getBoundingClientRect();
    return {
      text: (el.textContent ?? '').trim(),
      lines: middles.length,
      height: box.height,
      lineHeight,
      fontSize,
      overflow: el.scrollWidth > el.clientWidth,
      right: Math.max(box.right, ...rects.map((rect) => rect.right)),
      textWidth: Math.round(rects.reduce((sum, rect) => sum + rect.width, 0) * 10) / 10,
      boxWidth: Math.round(box.width * 10) / 10,
      viewport: document.documentElement.clientWidth,
    };
  });
}

async function expectOneLineTitle(page: Page, where: string): Promise<void> {
  await fontsReady(page);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 956 });
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(width);
    const metrics = await measureTitle(page);
    const label = `${where} à ${String(width)} px : « ${metrics.text} » (${JSON.stringify(metrics)})`;
    expect(metrics.lines, `${label} : titre sur plusieurs lignes`).toBe(1);
    expect(metrics.height, `${label} : hauteur d'une ligne`).toBeLessThanOrEqual(metrics.lineHeight + 1);
    expect(metrics.overflow, `${label} : titre rogné`).toBe(false);
    expect(metrics.right, `${label} : titre hors de l'écran`).toBeLessThanOrEqual(metrics.viewport);
  }
  // Retour à la taille de l'iPhone 16 Pro Max pour la suite du parcours.
  await page.setViewportSize({ width: WIDTHS[0], height: 956 });
}

test.describe('IOS-titres : titres des écrans iPhone sur une ligne (440, 430, 375 px)', () => {
  test.beforeEach(() => {
    test.skip(!test.info().project.name.startsWith('iphone'), 'iPhone seulement');
  });

  let synced: SyncedPage | null = null;
  let room = '';
  test.afterEach(async () => {
    await synced?.context.close();
    synced = null;
    if (room) await closeRoom(room);
    room = '';
  });

  test('Réglages › Synchronisation › Détails : « Synchronisation » sur une ligne', async ({ browser }) => {
    const info = test.info();
    room = `iostitres-${String(info.workerIndex)}-${info.testId}-${String(info.repeatEachIndex)}`;
    synced = await openSyncedPage(browser, room, 'iphone', 'first', 'iphone');
    await openSyncDetails(synced.page);
    await expect(synced.page.getByRole('heading', { name: 'Synchronisation', level: 1 })).toBeVisible();
    await expectOneLineTitle(synced.page, 'Détails de la synchronisation');
  });

  /*
   * Titres au texte fixe seulement. Ceux de Tâches (« 9 ven. ») et de la Semaine (« 5 – 11 oct. ») dépendent de la date du jour, et
   * partagent leur ligne avec des boutons : à 375 px ils passent déjà à la ligne, et une semaine à cheval sur deux mois
   * (« 28 sept. – 4 oct. ») ne tiendrait pas à côté des flèches même à 440 px ; le test serait vert ou rouge selon le jour. Écart
   * signalé à part, hors de ce correctif.
   */
  const tabs = [
    ['Routines', 'routinesscreen'],
    ['Événements', 'eventsscreen'],
    ['Checklists', 'checklistsscreen'],
    ['Réglages', 'settingsscreen'],
  ] as const;
  for (const [tab, screen] of tabs) {
    test(`onglet ${tab} : titre sur une ligne`, async ({ page }) => {
      await openApp(page);
      await waitForScreenLoaded(page, screen);
      await page.getByRole('navigation').getByRole('button', { name: tab, exact: true }).click();
      await expect(page.getByRole('heading', { name: tab, level: 1 })).toBeVisible();
      await expectOneLineTitle(page, `onglet ${tab}`);
    });
  }

  test('Réglages › Agendas : titre sur une ligne', async ({ page }) => {
    await openApp(page);
    await waitForScreenLoaded(page, 'settingsscreen');
    await waitForScreenLoaded(page, 'calendarsscreen');
    await page.getByRole('navigation').getByRole('button', { name: 'Réglages', exact: true }).click();
    await page.getByRole('button', { name: /^Agendas · Rappels Apple/ }).click();
    await expect(page.getByRole('heading', { name: 'Agendas', level: 1 })).toBeVisible();
    await expectOneLineTitle(page, 'Réglages › Agendas');
  });
});
