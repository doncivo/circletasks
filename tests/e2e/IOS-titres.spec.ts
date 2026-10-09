import { expect, test, type Locator, type Page } from '@playwright/test';
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
  const title = page.locator('main h1').first();
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

/**
 * `neighbours` : éléments qui partagent la rangée du titre (badge, boutons) : ils restent entiers dans l'écran, à droite du titre,
 * sans le chevaucher (le titre se réduit, eux non).
 */
async function expectOneLineTitle(page: Page, where: string, neighbours: readonly Locator[] = []): Promise<void> {
  await fontsReady(page);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 956 });
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(width);
    // useFitText s'ajuste à l'image suivante (notification de ResizeObserver ou événement `resize`, livrés pendant la mise à jour du
    // rendu). Attendre DEUX images (la seconde commence après la livraison de la première) : un état, jamais un délai. L'ancienne
    // attente (une seule ligne de texte) passait tout de suite avec `nowrap` : la mesure tombait avant l'ajustement (WebKit sous Linux).
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const metrics = await measureTitle(page);
    const label = `${where} à ${String(width)} px : « ${metrics.text} » (${JSON.stringify(metrics)})`;
    expect(metrics.lines, `${label} : titre sur plusieurs lignes`).toBe(1);
    expect(metrics.height, `${label} : hauteur d'une ligne`).toBeLessThanOrEqual(metrics.lineHeight + 1);
    expect(metrics.overflow, `${label} : titre rogné`).toBe(false);
    expect(metrics.right, `${label} : titre hors de l'écran`).toBeLessThanOrEqual(metrics.viewport);
    for (const neighbour of neighbours) {
      const box = await neighbour.boundingBox();
      expect(box, `${label} : voisin du titre absent`).not.toBeNull();
      if (!box) continue;
      expect(box.x, `${label} : voisin du titre chevauché`).toBeGreaterThanOrEqual(metrics.right - 0.5);
      expect(box.x + box.width, `${label} : voisin du titre hors de l'écran`).toBeLessThanOrEqual(metrics.viewport);
    }
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
   * Titres datés : horloge figée (test déterministe, quel que soit le jour du passage) sur les libellés les plus longs. Ils partagent
   * leur rangée avec des boutons ; le titre se réduit, badge et boutons restent entiers à sa droite.
   * - Tâches : jour à deux chiffres et jours courts les plus larges (« 28 mer. », « 27 dim. »), badge « AUJOURD'HUI » affiché.
   * - Semaine : semaines à cheval sur deux mois (« 28 sept. – 4 oct. », « 26 janv. – 1 févr. », « 29 juin – 5 juil. »).
   */
  const days = ['2026-10-28', '2026-09-27', '2026-09-30'] as const;
  for (const day of days) {
    test(`onglet Tâches, jour ${day} : titre sur une ligne à côté du badge et des boutons`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(`${day}T10:00:00+02:00`));
      await openApp(page);
      await expect(page.locator('main h1.ct-today__day')).toBeVisible();
      await expect(page.locator('.ct-today__badge')).toBeVisible();
      await expectOneLineTitle(page, `Tâches (${day})`, [page.locator('.ct-today__badge'), page.locator('.ct-today__headerActions')]);
    });
  }

  const weeks = [
    ['2026-09-30', '28 sept. – 4 oct.'],
    ['2026-01-28', '26 janv. – 1 févr.'],
    ['2026-07-01', '29 juin – 5 juil.'],
  ] as const;
  for (const [day, range] of weeks) {
    test(`onglet Semaine, « ${range} » : plage sur une ligne à côté des flèches`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(`${day}T10:00:00+02:00`));
      await openApp(page);
      await waitForScreenLoaded(page, 'weekscreen');
      await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
      await expect(page.getByRole('heading', { name: range, level: 1 })).toBeVisible();
      await expectOneLineTitle(page, `Semaine (${range})`, [page.locator('.ct-week__arrows')]);
    });
  }

  /*
   * Texte agrandi à 200 % (zoom du texte ; PRD : « jusqu'à 200 % ») : au plancher de taille, le titre peut passer à la ligne, mais
   * ENTRE deux mots seulement, sans déborder, et sans chevaucher ses voisins, qui restent dans l'écran.
   */
  const zoomed = [
    ['Tâches', '2026-10-28', 'main h1.ct-today__day', ['.ct-today__badge', '.ct-today__headerActions']],
    ['Semaine', '2026-09-30', 'main h1.ct-week__range', ['.ct-week__arrows']],
  ] as const;
  for (const [tab, day, selector, neighbours] of zoomed) {
    test(`onglet ${tab}, texte agrandi à 200 % : titre entier, coupé entre deux mots au besoin, voisins intacts`, async ({ page }) => {
      await page.clock.setFixedTime(new Date(`${day}T10:00:00+02:00`));
      // Taille de texte réglée avant le lancement (comme un réglage d'accessibilité déjà actif à l'ouverture de l'app).
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => document.documentElement.style.setProperty('font-size', '200%'));
      });
      await openApp(page);
      if (tab === 'Semaine') {
        await waitForScreenLoaded(page, 'weekscreen');
        await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
      }
      await expect(page.locator(selector)).toBeVisible();
      await fontsReady(page);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 956 });
        await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(width);
        const title = page.locator(selector);
        await expect.poll(() => title.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
        const report = await title.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0);
          // Chaque ligne commence par un mot entier : aucune ligne ne commence au milieu d'un mot (pas de coupure en pleine lettre).
          const words = (el.textContent ?? '').trim().split(/\s+/);
          const box = el.getBoundingClientRect();
          return {
            right: Math.max(...rects.map((rect) => rect.right)),
            bottom: box.bottom,
            words: words.length,
            rects: rects.length,
            viewport: document.documentElement.clientWidth,
          };
        });
        const label = `${tab} à 200 %, ${String(width)} px (${JSON.stringify(report)})`;
        expect(report.right, `${label} : titre hors de l'écran`).toBeLessThanOrEqual(report.viewport);
        expect(await title.evaluate((el) => getComputedStyle(el).overflowWrap), `${label} : coupure en pleine lettre permise`).not.toBe('anywhere');
        for (const neighbour of neighbours) {
          const box = await page.locator(neighbour).boundingBox();
          expect(box, `${label} : ${neighbour} absent`).not.toBeNull();
          if (!box) continue;
          // À droite du titre, ou passé dessous (rangée au plancher) : jamais par-dessus.
          const beside = box.x >= report.right - 0.5;
          const below = box.y >= report.bottom - 0.5;
          expect(beside || below, `${label} : ${neighbour} chevauche le titre (${JSON.stringify(box)})`).toBe(true);
          expect(box.x + box.width, `${label} : ${neighbour} hors de l'écran`).toBeLessThanOrEqual(report.viewport);
        }
      }
    });
  }

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
