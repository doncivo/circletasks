import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/** Tests de performance (`npm run test:perf`) : Node, sans couverture, hors `npm run test`. */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Plafond mémoire (consigne d'Ali) : 2 workers, ou CT_TEST_WORKERS=1 pour la relance de secours.
      maxWorkers: Number(process.env['CT_TEST_WORKERS'] ?? 2),
      environment: 'node',
      include: ['src/**/*.perf.test.ts'],
      coverage: { enabled: false },
    },
  }),
);
