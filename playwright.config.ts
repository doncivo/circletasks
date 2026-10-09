import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { E2E_DEV_PORT, E2E_PREVIEW_PORT, E2E_SIM_PORTS, E2E_WEBKIT_PORT, simUrl } from './tests/sim/ports';

/**
 * Ports de la suite e2e (voir tests/sim/ports.ts). Par défaut : Vite 1420, simulateurs 53701 (Google), 53702 (CalDAV), 53703 (dossier iCloud).
 * Plusieurs copies de travail en même temps : poser une base distincte et libre par copie, par exemple
 *   CT_E2E_PORT_BASE=41000 npx playwright test --project=pc     (Vite 41000, simulateurs 41001 à 41003)
 *   $env:CT_E2E_PORT_BASE=41010; npx playwright test            (PowerShell)
 * Le serveur de développement n'est JAMAIS réutilisé (reuseExistingServer: false, en local comme en CI) : si le port est déjà pris,
 * Playwright s'arrête avec « already used » au lieu de tester le serveur d'une autre copie.
 */
const BASE_URL = `http://localhost:${String(E2E_DEV_PORT)}`;
/** Build de production servi pour les mesures @perf (projet `perf`) : React en mode production, accroches de test rendues par VITE_CT_E2E_HOOKS. */
const PERF_URL = `http://localhost:${String(E2E_PREVIEW_PORT)}`;

const SIM_ENV_DEV = {
  CT_DEV_PORT: String(E2E_DEV_PORT),
  VITE_CT_GOOGLE_SIM: simUrl(E2E_SIM_PORTS.google),
  VITE_CT_CALDAV_SIM: simUrl(E2E_SIM_PORTS.caldav),
  VITE_CT_GOOGLE_SIM_CLIENT_ID: 'sim-client.apps.googleusercontent.com',
};

/** Projet des mesures @perf : défini avec son serveur de production seulement quand `CT_E2E_PERF=1` (job perf de la CI, `npm run test:perf:e2e`). */
const PERF = process.env['CT_E2E_PERF'] === '1';
const PERF_SERVER: NonNullable<PlaywrightTestConfig['webServer']> = {
      // Projet `perf` : build de production dans dist-perf (jamais dist, que lisent les tests du bundle de départ), puis prévisualisation.
      // VITE_CT_E2E_HOOKS=1 rend les accroches de test (import.meta.env.DEV) à ce build SEUL ; React reste en mode production.
      command: `npx vite build --outDir dist-perf --emptyOutDir && npx vite preview --outDir dist-perf --port ${String(E2E_PREVIEW_PORT)} --strictPort`,
      url: PERF_URL,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { ...SIM_ENV_DEV, VITE_CT_E2E_HOOKS: '1' },
    };
const PERF_PROJECT: NonNullable<PlaywrightTestConfig['projects']>[number] = {
      // Mesures de temps d'affichage (PRD 8, tests marqués @perf) : lancées APRÈS les projets pc et iphone, quand la machine n'est
      // plus occupée par les autres tests en parallèle. Les mesures sans concurrence : `npm run test:perf`.
      name: 'perf',
      // Bundle de production (second serveur ci-dessous) : les budgets du PRD 8 se mesurent sur ce que l'utilisateur installe, pas sur React en
      // mode développement (rendu environ deux fois plus lent).
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, baseURL: PERF_URL },
      grep: /@perf/,
      dependencies: ['pc', 'iphone'],
      // Consigne d'Ali : une mesure n'est jamais rejouée (aucune nouvelle tentative, même en CI).
      retries: 0,
    };

/**
 * Projet `iphone-webkit` (WebKit, moteur de la WebView iOS) : défini avec son serveur seulement quand `CT_E2E_WEBKIT=1` (job e2e-webkit
 * de la CI ; en local : `CT_E2E_WEBKIT=1 npx playwright test --project=iphone-webkit`). ADR 0002 : « ajouter WebKit si un écart de rendu Safari apparaît » ; c'est le cas en 0.2.3
 * (titre « Synchronisation » sur deux lignes sur l'iPhone). Seulement les contrôles de mise en page (IOS-titres), polices embarquées
 * réelles. Build de production avec les accroches de test (même recette que `perf`) : WebKit charge les centaines de modules du serveur
 * de développement trop lentement pour le budget d'un test (plus de 30 s par page sous Windows).
 */
const WEBKIT = process.env['CT_E2E_WEBKIT'] === '1';
const WEBKIT_URL = `http://localhost:${String(E2E_WEBKIT_PORT)}`;
const WEBKIT_SERVER: NonNullable<PlaywrightTestConfig['webServer']> = {
  command: `npx vite build --outDir dist-webkit --emptyOutDir && npx vite preview --outDir dist-webkit --port ${String(E2E_WEBKIT_PORT)} --strictPort`,
  url: WEBKIT_URL,
  reuseExistingServer: false,
  timeout: 240_000,
  env: { ...SIM_ENV_DEV, VITE_CT_E2E_HOOKS: '1' },
};
const WEBKIT_PROJECT: NonNullable<PlaywrightTestConfig['projects']>[number] = {
  name: 'iphone-webkit',
  testMatch: /IOS-titres\.spec\.ts$/,
  use: {
    browserName: 'webkit',
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    baseURL: WEBKIT_URL,
  },
  grepInvert: /@perf/,
};

export default defineConfig({
  testDir: 'tests/e2e',
  // Simulateurs d'agendas Google et CalDAV (K-01 à K-03) sur les ports de tests/sim/ports.ts, arrêtés à la fin de la suite.
  globalSetup: './tests/e2e/globalSetup.ts',
  fullyParallel: true,
  // Plafond mémoire (consigne d'Ali) : 2 workers, ou CT_TEST_WORKERS=1 pour la relance de secours.
  workers: Number(process.env['CT_TEST_WORKERS'] ?? 2),
  forbidOnly: !!process.env['CI'],
  // Consigne d'Ali : aucun nouvel essai, ni en local ni en CI ; un test instable se corrige, il ne se rejoue pas.
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'pc',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
      grepInvert: /@perf/,
    },
    {
      // iPhone 16 Pro Max : 440 x 956 points CSS. Chromium en émulation mobile ;
      // WebKit à évaluer plus tard (voir ADR 0002, points ouverts).
      name: 'iphone',
      use: {
        browserName: 'chromium',
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
      grepInvert: /@perf/,
    },
    ...(WEBKIT ? [WEBKIT_PROJECT] : []),
    ...(PERF ? [PERF_PROJECT] : []),
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: SIM_ENV_DEV,
    },
    ...(WEBKIT ? [WEBKIT_SERVER] : []),
    ...(PERF ? [PERF_SERVER] : []),
  ],
});
