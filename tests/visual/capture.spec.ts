import { expect, test, type Browser, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { setWheels } from '../e2e/helpers/schedule';
import { createTask, openToday } from '../e2e/helpers/today';
import { attachTasks, insertGoals } from '../e2e/helpers/goals';
import { insertChecklists, openChecklists } from '../e2e/helpers/checklists';
import { insertEvents, openEvents, type DirectEvent } from '../e2e/helpers/events';
import { insertRoutines, openRoutines, type DirectRoutine } from '../e2e/helpers/routines';
import { addProject, filterPill, openSpacesScreen, setTaskProject } from '../e2e/helpers/spaces';
import { insertSomeday, openSomeday } from '../e2e/helpers/someday';
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
  // Routines d'Aujourd'hui (Main.html, PC-Aujourdhui.html) : « Boire de l'eau » 08:30, « Faire mon lit » validée, Sport 18:00 (PC).
  await insertRoutines(page, [
    { title: "Boire de l'eau", space: 'perso', time: '08:30', icon: 'lucide:glass-water', done: ['2026-09-22'] },
    { title: 'Faire mon lit', space: 'perso', time: '07:30', icon: 'lucide:bed', done: ['2026-09-23'] },
    // Sport 18:00 : seulement dans PC-Aujourdhui.html.
    ...(testInfo.project.name === 'pc'
      ? [{ title: 'Sport', space: 'perso', time: '18:00', icon: 'lucide:dumbbell', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: '2026-06-01' } satisfies DirectRoutine]
      : []),
  ]);
  // Objectif de la semaine épinglé « 2/5 » (Main.html, PC-Aujourdhui.html) ; ses tâches tombent un autre jour que le mercredi affiché.
  await seedGoalWithTasks(page, 'other-days');
  // Aujourd'hui relit ses routines à l'ouverture : on repasse par la Semaine.
  await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Envoyer la facture', exact: true })).toBeVisible();
}

/** Titres de l'objectif de la maquette Objectif.html : 2 faites sur 5, jours lun. à ven. (« other-days » : la tâche du mercredi passe au samedi). */
const GOAL_TITLE = 'Finaliser le PRD CircleTasks';
const GOAL_TASKS = ['Relire les user stories', 'Valider les maquettes', 'Mettre à jour CLAUDE.md', 'Préparer le dépôt GitHub', 'Lancer Claude Code'];

async function seedGoalWithTasks(page: Page, days: 'objectif' | 'other-days'): Promise<void> {
  await insertGoals(page, [
    { title: GOAL_TITLE, weekStart: '2026-09-21' },
    // « SEMAINES PRÉCÉDENTES » (Objectif.html) : S38 atteint, S37 non atteint.
    { title: 'Trier les papiers administratifs', weekStart: '2026-09-07', status: 'closed', pinned: false },
    { title: 'Clôturer la paie de septembre', weekStart: '2026-09-14', status: 'achieved', pinned: false },
  ]);
  await insertTasks(page, [
    { title: GOAL_TASKS[0] as string, date: '2026-09-21', done: true },
    { title: GOAL_TASKS[1] as string, date: '2026-09-22', done: true },
    { title: GOAL_TASKS[2] as string, date: days === 'objectif' ? '2026-09-23' : '2026-09-26' },
    { title: GOAL_TASKS[3] as string, date: '2026-09-24' },
    { title: GOAL_TASKS[4] as string, date: '2026-09-25' },
  ]);
  await attachTasks(page, GOAL_TITLE, GOAL_TASKS);
}

/** Les six tâches de UnJour.html (iPhone) et leurs projets ; la première est dépliée dans la maquette. */
async function prepareSomeday(page: Page, expandFirst: boolean, testInfo: { project: { name: string } }): Promise<void> {
  await openSpacesScreen(page);
  await addProject(page, 'Pro', 'Mission client');
  await addProject(page, 'Perso', 'Rappels Apple');
  await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
  await insertSomeday(page, [
    { title: 'Renouveler le passeport', space: 'perso' },
    { title: 'Préparer la présentation Q4', project: 'Mission client' },
    { title: 'Lire le rapport annuel' },
    { title: 'Trier les photos de vacances', space: 'perso' },
    { title: "Réparer l'étagère", space: 'perso' },
    { title: 'Changer de forfait mobile', space: 'perso', project: 'Rappels Apple' },
  ]);
  await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
  await openSomeday(page, testInfo);
  if (expandFirst) await page.getByRole('button', { name: 'Renouveler le passeport', exact: true }).click();
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
  // Objectif épinglé de la semaine (PC-Semaine.html : bandeau « OBJECTIF · … · 2/5 ») : cinq tâches de la semaine, deux faites.
  await insertGoals(page, [{ title: GOAL_TITLE, weekStart: '2026-09-21' }]);
  await attachTasks(page, GOAL_TITLE, ['Relire le contrat', 'Appeler la banque', 'Envoyer la facture', 'Préparer le dépôt GitHub', 'Clôture mensuelle']);
  await seedCalendarAccount(page);
  await seedExternalEvent(page, { id: 'visual-1', title: 'Point client', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' });
  // Routines de la Semaine (PC-Semaine.html : « 07:30 · Routine », « 18:00 · Routine » les lundis, mercredis et vendredis).
  await insertRoutines(page, [
    // « Faire mon lit » le lundi seulement, comme la maquette.
    { title: 'Faire mon lit', space: 'perso', time: '07:30', icon: 'lucide:bed', scheduleType: 'weekdays', weekdays: [1], startDate: '2026-09-01', done: ['2026-09-21'] },
    { title: 'Sport', space: 'perso', time: '18:00', icon: 'lucide:dumbbell', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: '2026-06-01', done: ['2026-09-21'] },
  ]);
  await openWeek(page);
}

/** Routines des maquettes (semaine du 21 au 27 sept. 2026, mercredi 23) : icônes du catalogue le plus proche (pas de « soleil »). */
const SERIES_12 = Array.from({ length: 12 }, (_, i) => `2026-09-${String(12 + i).padStart(2, '0')}`);
const SPORT_BEST = ['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-13', '2026-07-15', '2026-07-17', '2026-07-20', '2026-07-22', '2026-07-24', '2026-07-27', '2026-07-29'];
const ROUTINE_SEED: DirectRoutine[] = [
  { title: 'Faire mon lit', space: 'perso', time: '07:30', icon: 'lucide:bed', done: SERIES_12 },
  { title: "Boire de l'eau", space: 'perso', time: '08:30', icon: 'lucide:glass-water', done: ['2026-09-21', '2026-09-22'] },
  {
    title: 'Sport',
    space: 'perso',
    time: '18:00',
    icon: 'lucide:dumbbell',
    scheduleType: 'weekdays',
    weekdays: [1, 3, 5],
    startDate: '2026-06-01',
    reminders: [0],
    // 11 séances de suite en juillet (meilleure série), puis 4 séances depuis le 14 sept. (série en cours).
    done: [...SPORT_BEST, '2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21'],
  },
  { title: 'Lire 20 minutes', space: 'perso', time: '21:30', icon: 'lucide:book-open', done: ['2026-09-21', '2026-09-22'] },
];
const ROUTINE_SEED_PC: DirectRoutine[] = [
  ...ROUTINE_SEED,
  { title: 'Revue des e-mails', space: 'pro', time: '08:45', icon: 'lucide:mail', scheduleType: 'weekdays', weekdays: [1, 3, 5], done: ['2026-09-21', '2026-09-23'] },
  { title: 'Point hebdo', space: 'pro', time: '09:00', icon: 'lucide:clock', scheduleType: 'weekdays', weekdays: [1], done: ['2026-09-21'] },
];

async function prepareRoutines(page: Page, items: DirectRoutine[]): Promise<void> {
  await insertRoutines(page, items);
  await openRoutines(page);
}

const STRETCH: DirectRoutine = {
  title: "Séance d'étirements",
  space: 'perso',
  time: '18:00',
  icon: 'lucide:dumbbell',
  scheduleType: 'every_n_days',
  interval: 3,
  startDate: '2026-09-21',
  reminders: [0],
  done: ['2026-09-21'],
};

/** Checklists des maquettes (Checklists.html, PC-Checklists.html) : « Valise voyage » 3 / 6 (modèle Perso), Courses, Documents comptables, Fête de fin d'année. */
const VALISE_ITEMS = [
  'Adaptateur de prise',
  'Crème solaire',
  "Attestation d'assurance",
  ['Passeport', true],
  ['Chargeur', true],
  ["Billets d'avion", true],
] as const;

async function prepareChecklists(page: Page, all: boolean): Promise<void> {
  await insertChecklists(page, [
    { title: 'Valise voyage', space: 'perso', icon: 'lucide:briefcase', template: true, items: VALISE_ITEMS },
    ...(all
      ? ([
          { title: 'Courses', space: 'perso', icon: 'lucide:shopping-cart', items: Array.from({ length: 8 }, (_, i) => `Article ${String(i + 1)}`) },
          { title: 'Documents comptables', space: 'pro', icon: 'lucide:file-text', items: [['Factures', true], ['Relevés', true], 'TVA', 'Notes de frais', 'Bilan'] },
          { title: "Fête de fin d'année", space: 'perso', icon: 'lucide:gift', items: [['Salle', true], ...Array.from({ length: 11 }, (_, i) => `Invité ${String(i + 1)}`)] },
        ] as const)
      : []),
  ]);
  await openChecklists(page);
  await expect(page.getByText('3 / 6').first()).toBeVisible();
}

/**
 * Événements des maquettes (Evenements.html, PC-Evenements.html), jour figé au mer. 23 sept. 2026 : « Point client » (Google Agenda,
 * externe), anniversaire de Karim, comité mensuel, point trimestriel ; « Clôture du trimestre » seulement sur PC. Les jours fériés
 * (Fête de l'Évacuation, Toussaint, Armistice) viennent des calendriers FR et TN activés par défaut (E-03).
 */
const EVENTS_SEED: DirectEvent[] = [
  { title: 'Anniversaire de Karim', date: '1992-09-25', kind: 'birthday', repeat: 'yearly', birthYear: 1992, space: 'perso', important: true, icon: 'lucide:gift' },
  { title: 'Comité de direction', date: '2026-10-05', repeat: 'monthly', important: true },
  { title: 'Point trimestriel', date: '2026-10-20', start: '09:30', end: '09:30', important: true },
];

async function prepareEvents(page: Page, pc: boolean): Promise<void> {
  await insertEvents(page, [...EVENTS_SEED, ...(pc ? [{ title: 'Clôture du trimestre', date: '2026-09-30', important: true } satisfies DirectEvent] : [])]);
  await seedCalendarAccount(page);
  await seedExternalEvent(page, { id: 'visual-1', title: 'Point client', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' });
  await openEvents(page);
  await expect(page.getByText('Point client').first()).toBeVisible();
}

interface Screen {
  name: string;
  mockup: string;
  viewport: { width: number; height: number };
  date: Date;
  dark?: boolean;
  prepare?: (page: Page, testInfo: { project: { name: string } }) => Promise<void>;
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
  {
    // Écran Objectif iPhone (Objectif.html) : objectif « Finaliser le PRD CircleTasks », 2 faites sur 5.
    name: 'Objectif',
    mockup: 'Objectif.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await seedGoalWithTasks(page, 'objectif');
      await page.getByRole('navigation').getByRole('button', { name: 'Semaine', exact: true }).click();
      await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
      await page.getByRole('button', { name: 'Objectif de la semaine', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Objectif', exact: true })).toBeVisible();
      await expect(page.getByText('2 faites sur 5')).toBeVisible();
    },
  },
  {
    // Écran « Un jour » (UnJour.html) : six tâches sans date, la première dépliée avec « Aujourd'hui », « Demain », « Choisir une date ».
    name: 'UnJour',
    mockup: 'UnJour.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: (page, testInfo) => prepareSomeday(page, true, testInfo),
  },
  {
    // Semaine PC avec le panneau « Un jour » (PC-Semaine-UnJour.html) : « Préparer la présentation Q4 » soulevée au-dessus du jeudi 24.
    name: 'PC-Semaine-UnJour',
    mockup: 'PC-Semaine-UnJour.html',
    viewport: PC,
    date: WEDNESDAY,
    prepare: async (page) => {
      await openSpacesScreen(page);
      await addProject(page, 'Pro', 'Mission client');
      await addProject(page, 'Perso', 'Rappels Apple');
      await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
      await insertSomeday(page, [
        { title: 'Renouveler le passeport', space: 'perso' },
        { title: 'Préparer la présentation Q4', project: 'Mission client' },
        { title: 'Changer de forfait mobile', space: 'perso', project: 'Rappels Apple' },
      ]);
      await prepareWeek(page);
      await page.getByRole('button', { name: /^Un jour/ }).click();
      const panel = page.getByRole('complementary', { name: 'Un jour' });
      await expect(panel).toBeVisible();
      const card = panel.locator('[data-drag-id]').filter({ has: page.getByRole('button', { name: 'Préparer la présentation Q4', exact: true }) });
      const from = await card.boundingBox();
      const target = await page.locator('.ct-week-day[data-date="2026-09-24"]').boundingBox();
      if (!from || !target) throw new Error('éléments introuvables');
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 - 12, from.y + from.height / 2 + 8, { steps: 3 });
      await page.mouse.move(target.x + target.width / 2, target.y + 330, { steps: 12 });
      await expect(page.getByText('Déposer ici · jeu. 24')).toBeVisible();
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
  { name: 'Routines', mockup: 'Routines.html', viewport: PHONE, date: WEDNESDAY, prepare: (page) => prepareRoutines(page, ROUTINE_SEED) },
  {
    name: 'PC-Routines',
    mockup: 'PC-Routines.html',
    viewport: PC,
    date: WEDNESDAY,
    prepare: async (page) => {
      await prepareRoutines(page, ROUTINE_SEED_PC);
      // Sport sélectionnée : le rapport s'ouvre dans le panneau de droite (PC-Routines.html).
      await page.locator('article.ct-routine-card', { hasText: 'Sport' }).locator('.ct-routine-card__info').click();
      await expect(page.getByRole('complementary', { name: 'Rapport de la routine' })).toBeVisible();
    },
  },
  {
    name: 'ModifierRoutine',
    mockup: 'ModifierRoutine.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await prepareRoutines(page, ROUTINE_SEED);
      await page.getByRole('button', { name: 'Éditer la routine Sport' }).click();
      await expect(page.getByRole('form', { name: 'Modifier la routine' })).toBeVisible();
    },
  },
  {
    name: 'ModifierRoutine-N',
    mockup: 'ModifierRoutine-N.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await prepareRoutines(page, [STRETCH]);
      await page.getByRole('button', { name: "Éditer la routine Séance d'étirements" }).click();
      await expect(page.getByRole('form', { name: 'Modifier la routine' })).toBeVisible();
    },
  },
  {
    // La maquette est le rapport mensuel GLOBAL (H-01) ; seule sa section routines est construite ici (tuiles, Focus, objectifs : H-01).
    name: 'Rapport',
    mockup: 'Rapport.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await prepareRoutines(page, ROUTINE_SEED);
      await page.getByRole('button', { name: 'Rapport du mois' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'septembre' })).toBeVisible();
    },
  },
  {
    // Feuille « Nouvelle tâche » avec une heure (14:00) : bloc Rappel actif, « À l'heure » cochée d'office (N-02, QB-08).
    name: 'Ajout',
    mockup: 'Ajout.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Ajouter' }).click();
      const dialog = page.getByRole('dialog', { name: 'Nouvelle tâche' });
      await dialog.getByLabel('Titre').fill('Appeler le notaire');
      await setWheels(page, dialog, { time: '14:00' });
      await expect(dialog.getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-checked', 'true');
    },
  },
  {
    // Réglages : section RAPPELS, ligne « Récapitulatifs » 07:30 · 21:00 (N-04, QB-09). Les autres sections arrivent avec M12.
    name: 'Reglages',
    mockup: 'Reglages.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
      await expect(page.getByRole('button', { name: /^Récapitulatifs :/ })).toBeVisible();
    },
  },
  {
    // Espaces et projets (ES-01, ES-04) : écran non dessiné, comparé à la carte d'espace de Bienvenue.html.
    name: 'Espaces',
    mockup: 'Bienvenue.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await openSpacesScreen(page);
      await addProject(page, 'Pro', 'Mission client');
    },
  },
  {
    // Menu « Projet : tous » à droite des pastilles (QB-15), sous le filtre Pro avec un projet actif ; non dessiné dans Main.html.
    name: 'Main-Projet',
    mockup: 'Main.html',
    viewport: PHONE,
    date: WEDNESDAY,
    data: true,
    prepare: async (page) => {
      await openSpacesScreen(page);
      await addProject(page, 'Pro', 'Mission client');
      await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
      await filterPill(page, 'Pro').click();
      await expect(page.getByRole('combobox', { name: 'Filtre de projet' })).toBeVisible();
    },
  },
  {
    // Fiche détail PC avec la ligne « Projet » (PC-Aujourdhui.html : « Mission client ») et le menu « Projet : tous » à droite des pastilles.
    name: 'PC-Aujourdhui-Projet',
    mockup: 'PC-Aujourdhui.html',
    viewport: PC,
    date: WEDNESDAY,
    data: true,
    prepare: async (page) => {
      await openSpacesScreen(page);
      await addProject(page, 'Pro', 'Mission client');
      await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
      await setTaskProject(page, { project: { name: 'pc' } }, 'Envoyer la facture', 'Mission client');
      await filterPill(page, 'Pro').click();
      await page.getByRole('button', { name: 'Envoyer la facture', exact: true }).click();
      await expect(page.getByRole('complementary')).toBeVisible();
    },
  },
  { name: 'Evenements', mockup: 'Evenements.html', viewport: PHONE, date: WEDNESDAY, prepare: (page) => prepareEvents(page, false) },
  { name: 'PC-Evenements', mockup: 'PC-Evenements.html', viewport: PC, date: WEDNESDAY, prepare: (page) => prepareEvents(page, true) },
  {
    // Feuille « Nouvel événement » (AjoutEvenement.html) : titre saisi, journée entière, répétition annuelle, rappel « La veille ».
    name: 'AjoutEvenement',
    mockup: 'AjoutEvenement.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: async (page) => {
      await openEvents(page);
      await page.getByRole('button', { name: 'Ajouter un événement' }).click();
      const dialog = page.getByRole('dialog', { name: 'Nouvel événement' });
      await dialog.getByLabel('Titre', { exact: true }).fill('Anniversaire de Karim');
      await dialog.getByRole('radio', { name: 'Annuel' }).check();
      await dialog.getByRole('checkbox', { name: 'Le jour même' }).check();
      await dialog.getByRole('button', { name: 'Perso', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
    },
  },
  {
    name: 'Checklists',
    mockup: 'Checklists.html',
    viewport: PHONE,
    date: WEDNESDAY,
    prepare: (page) => prepareChecklists(page, false),
  },
  {
    name: 'PC-Checklists',
    mockup: 'PC-Checklists.html',
    viewport: PC,
    date: WEDNESDAY,
    prepare: async (page) => {
      await prepareChecklists(page, true);
      // Tri par titre (décision C-01 D3) : la maquette montre « Valise voyage » ouverte, on la choisit dans le volet.
      await page.getByRole('list', { name: 'Mes checklists' }).getByRole('button', { name: /^Valise voyage/ }).click();
      await expect(page.getByRole('heading', { level: 2, name: 'Valise voyage' })).toBeVisible();
    },
  },
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
    await screen.prepare?.(page, { project: { name: phone ? 'iphone' : 'pc' } });
    await captureApp(page, screen.name);
    await captureMockup(browser, screen.viewport, screen.mockup, screen.name, screen.dark);
    await context.close();
  });
}
