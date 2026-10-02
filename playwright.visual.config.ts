import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Captures app / maquettes (npm run visual) : hors `npm run e2e`. */
export default defineConfig({
  ...base,
  testDir: 'tests/visual',
  fullyParallel: false,
  workers: 1,
  projects: [{ name: 'visual', use: { browserName: 'chromium' } }],
});
