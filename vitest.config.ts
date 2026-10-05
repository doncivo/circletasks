import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Plafond mémoire (consigne d'Ali) : 2 workers, ou CT_TEST_WORKERS=1 pour la relance de secours.
      maxWorkers: Number(process.env['CT_TEST_WORKERS'] ?? 2),
      // Deux projets : logique pure en Node (domain, db, sync, i18n), composants React en jsdom.
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            // PERF-02 : analyseur des dates écrites posé d'emblée (chargé à la demande dans l'app).
            setupFiles: ['tests/setup/absoluteDates.ts'],
            include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'scripts/release/**/*.test.ts'],
            // Mesures de performance : hors de `npm run test` (script `test:perf`).
            exclude: ['**/*.perf.test.ts', '**/node_modules/**'],
          },
        },
        {
          extends: true,
          test: {
            name: 'dom',
            environment: 'jsdom',
            include: ['src/**/*.test.tsx'],
            setupFiles: ['tests/setup/absoluteDates.ts', 'tests/setup/dom.ts'],
            // Plusieurs agents et workers tournent en parallèle sur la machine : marge pour les écrans qui ouvrent une base en mémoire.
            testTimeout: 15_000,
          },
        },
      ],
      coverage: {
        enabled: true,
        provider: 'v8',
        reporter: ['text-summary', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/main.tsx', 'src/**/*.d.ts'],
        thresholds: {
          // PRD section 8 : règles métier couvertes à 80 % minimum.
          'src/domain/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
        },
      },
    },
  }),
);
