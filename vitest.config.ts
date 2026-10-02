import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Deux projets : logique pure en Node (domain, db, sync, i18n), composants React en jsdom.
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
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
            setupFiles: ['tests/setup/dom.ts'],
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
