import { defineConfig } from '@playwright/test';

/**
 * REL-TECH-01 (ADR 0016) : test de fumée du vrai binaire Windows (tests/smoke). Aucun serveur : le binaire embarque le front
 * (`npm run test:smoke:build`), puis `npm run test:smoke`. Un seul worker (une seule app, un seul port CDP), aucun nouvel essai
 * (consigne d'Ali : un test instable se corrige, il ne se rejoue pas). Job `smoke-windows` de la CI, requis par « suite verte ».
 */
export default defineConfig({
  testDir: 'tests/smoke',
  outputDir: 'test-results/smoke',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env['CI'],
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    locale: 'fr-FR',
    trace: 'off',
  },
});
