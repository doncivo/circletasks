import { defineConfig } from 'vitest/config';

/**
 * Taille du bundle de départ (`npm run test:bundle`) : un vrai `npm run build` vers un dossier temporaire, donc lent (une à deux minutes).
 * Hors de `npm run test` (les configurations de test n'incluent pas `tests/bundle`).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/bundle/**/*.test.ts'],
    coverage: { enabled: false },
    testTimeout: 600_000,
    hookTimeout: 600_000,
    maxWorkers: 1,
  },
});
