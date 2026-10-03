import { defineConfig } from '@playwright/test';

const PORT = 1420;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // Plafond mémoire (consigne d'Ali) : 2 workers, ou CT_TEST_WORKERS=1 pour la relance de secours.
  workers: Number(process.env['CT_TEST_WORKERS'] ?? 2),
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
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
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
