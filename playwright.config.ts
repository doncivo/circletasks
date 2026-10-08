import { defineConfig } from '@playwright/test';
import { E2E_DEV_PORT, E2E_SIM_PORTS, simUrl } from './tests/sim/ports';

/**
 * Ports de la suite e2e (voir tests/sim/ports.ts). Par défaut : Vite 1420, simulateurs 53701 (Google), 53702 (CalDAV), 53703 (dossier iCloud).
 * Plusieurs copies de travail en même temps : poser une base distincte et libre par copie, par exemple
 *   CT_E2E_PORT_BASE=41000 npx playwright test --project=pc     (Vite 41000, simulateurs 41001 à 41003)
 *   $env:CT_E2E_PORT_BASE=41010; npx playwright test            (PowerShell)
 * Le serveur de développement n'est JAMAIS réutilisé (reuseExistingServer: false, en local comme en CI) : si le port est déjà pris,
 * Playwright s'arrête avec « already used » au lieu de tester le serveur d'une autre copie.
 */
const BASE_URL = `http://localhost:${String(E2E_DEV_PORT)}`;

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
    {
      // Mesures de temps d'affichage (PRD 8, tests marqués @perf) : lancées APRÈS les projets pc et iphone, quand la machine n'est
      // plus occupée par les autres tests en parallèle. Les mesures sans concurrence : `npm run test:perf`.
      name: 'perf',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
      grep: /@perf/,
      dependencies: ['pc', 'iphone'],
      // Consigne d'Ali : une mesure n'est jamais rejouée (aucune nouvelle tentative, même en CI).
      retries: 0,
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_CT_GOOGLE_SIM: simUrl(E2E_SIM_PORTS.google), VITE_CT_CALDAV_SIM: simUrl(E2E_SIM_PORTS.caldav), VITE_CT_GOOGLE_SIM_CLIENT_ID: 'sim-client.apps.googleusercontent.com' },
  },
});
