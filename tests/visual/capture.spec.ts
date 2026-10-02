import { expect, test, type Browser, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createTask, openToday } from '../e2e/helpers/today';
import { insertTasks, openWeek, seedCalendarAccount, seedExternalEvent, type DirectTask } from '../e2e/helpers/week';

/**
 * Comparaison visuelle manuelle (npm run visual) : capture l'app et la maquette correspondante à la même
 * taille. Aucune comparaison au pixel : les paires sont écrites dans test-results/visual/ pour revue humaine.
 * Date figée au mer. 23 sept. 2026 10:00 (Europe/Paris) comme dans les maquettes.
 */
const OUT = resolve('test-results/visual');
const MOCKUPS = resolve('docs/maquettes');
const PHONE = { width: 440, height: 956 };
const PC = { width: 1440, height: 900 };
const WEDNESDAY = new Date('2026-09-23T08:00:00Z'); // 10:00 à Paris
const SUNDAY = new Date('2026-09-27T08:00:00Z');

mkdirSync(OUT, { recursive: true });

async function captureMockup(browser: Browser, viewport: { width: number; height: number }, file: string, name: string, dark = false): Promise<void> {
  // Contexte non mobile : une page statique sans balise viewport serait sinon réduite à 980 px de large.
  const context = await browser.newContext({ viewport, locale: 'fr-FR', colorScheme: dark ? 'dark' : 'light' });
  const page = await context.newPage();
  await page.goto(pathToFileURL(resolve(MOCKUPS, file)).href, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: resolve(OUT, `${name}-maquette.png`) });
  await context.close();
}

async function seed(page: Page, testInfo: { project: { name: string } }): Promise<void> {
  await createTask(page, testInfo, { title: 'Envoyer la facture', time: '09:00' });
  await createTask(page, testInfo, { title: 'Appeler le notaire', time: '14:00' });
  await createTask(page, testInfo, { title: 'Acheter du pain' });
}

async function captureApp(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT, `${name}-app.png`) });
}

/** Semaine du 21 au 27 sept. 2026 des maquettes (tâches et « Point client » ; routines, anniversaire et objectif arrivent avec leurs modules). */
const WEEK_SEED: DirectTask[] = [
  { title: 'Relire le contrat', date: '2026-09-21', done: true },
  { title: 'Appeler la banque', date: '2026-09-22', space: 'perso', done: true },
  { title: 'Mettre à jour le budget', date: '2026-09-22', carried: true },
  { title: 'Envoyer la facture', date: '2026-09-23', time: '09:00' },
  { title: 'Appeler le notaire', date: '2026-09-23', time: '14:00', space: 'perso' },
  { title: "Réunion d'équipe", date: '2026-09-24', time: '11:00' },
  { title: 'Préparer le dépôt GitHub', date: '2026-09-24', space: 'perso' },
  { title: 'Clôture mensuelle', date: '2026-09-25' },
  { title: 'Courses', date: '2026-09-26', space: 'perso' },
];

async function prepareWeek(page: Page): Promise<void> {
  await insertTasks(page, WEEK_SEED);
  // « Point client » 10:00 (Google Agenda) : 08:00Z en septembre à Paris ; l'anniversaire (événement local) attend le module Événements.
  await seedCalendarAccount(page);
  await seedExternalEvent(page, { id: 'visual-1', title: 'Point client', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' });
  await openWeek(page);
}

interface Screen {
  name: string;
  mockup: string;
  viewport: { width: number; height: number };
  date: Date;
  dark?: boolean;
  prepare?: (page: Page) => Promise<void>;
  data?: boolean;
}

const SCREENS: Screen[] = [
  { name: 'Main', mockup: 'Main.html', viewport: PHONE, date: WEDNESDAY, data: true },
  {
    name: 'Main-Edition',
    mockup: 'Main-Edition.html',
    viewport: PHONE,
    date: WEDNESDAY,
    data: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Mode édition' }).click();
    },
  },
  {
    name: 'Main-Compact',
    mockup: 'Main-Compact.html',
    viewport: PHONE,
    date: WEDNESDAY,
    data: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Vue compacte' }).click();
    },
  },
  { name: 'Main-Vide', mockup: 'Main-Vide.html', viewport: PHONE, date: SUNDAY },
  { name: 'Main-Sombre', mockup: 'Main-Sombre.html', viewport: PHONE, date: WEDNESDAY, dark: true, data: true },
  {
    name: 'Detail',
    mockup: 'Detail.html',
    viewport: PHONE,
    date: WEDNESDAY,
    data: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Envoyer la facture', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
  },
  {
    name: 'PC-Aujourdhui',
    mockup: 'PC-Aujourdhui.html',
    viewport: PC,
    date: WEDNESDAY,
    data: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Envoyer la facture', exact: true }).click();
      await expect(page.getByRole('complementary')).toBeVisible();
    },
  },
  { name: 'Semaine', mockup: 'Semaine.html', viewport: PHONE, date: WEDNESDAY, prepare: prepareWeek },
  { name: 'PC-Semaine', mockup: 'PC-Semaine.html', viewport: PC, date: WEDNESDAY, prepare: prepareWeek },
];

for (const screen of SCREENS) {
  test(`capture ${screen.name}`, async ({ browser }) => {
    const phone = screen.viewport === PHONE;
    const context = await browser.newContext({
      viewport: screen.viewport,
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      colorScheme: screen.dark ? 'dark' : 'light',
      ...(phone ? { deviceScaleFactor: 1, isMobile: true, hasTouch: true } : {}),
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(screen.date);
    await openToday(page);
    if (screen.data) await seed(page, { project: { name: phone ? 'iphone' : 'pc' } });
    await screen.prepare?.(page);
    await captureApp(page, screen.name);
    await captureMockup(browser, screen.viewport, screen.mockup, screen.name, screen.dark);
    await context.close();
  });
}
