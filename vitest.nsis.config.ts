import { defineConfig } from 'vitest/config';

/**
 * REL-TECH-02 : garde-fou du script NSIS réellement généré (`npm run test:nsis`). Il lit `installer.nsi`, que seul `tauri build --bundles nsis`
 * produit (job `smoke-windows` de la CI, qui le construit avant). Hors de `npm run test` et des tranches Vitest de la CI, où ce fichier n'existe pas :
 * les configurations de test n'incluent pas `tests/nsis`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/nsis/**/*.test.ts'],
    coverage: { enabled: false },
    maxWorkers: 1,
  },
});
