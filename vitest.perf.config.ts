import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/** Tests de performance (`npm run test:perf`) : Node, sans couverture, hors `npm run test`. */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.perf.test.ts'],
      coverage: { enabled: false },
    },
  }),
);
