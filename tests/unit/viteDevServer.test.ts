import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

/**
 * K-01 (régression PERF-02) : le serveur de développement lancé par Playwright répondait ~10 s trop tard à la première page (goto
 * « load » au-delà de 30 s). Le surveillant de fichiers et le balayage des dépendances parcouraient les rapports de couverture et les
 * worktrees d'agents (plus de 7 000 .html) ; ils ne doivent regarder que les sources.
 */
describe('vite.config : serveur de développement', () => {
  it('le surveillant ignore les dossiers générés et les worktrees', () => {
    const ignored = config.server?.watch?.ignored as string[];
    for (const dir of ['.claude', 'coverage-qa', 'test-results', 'playwright-report', 'dist']) {
      expect(ignored.some((glob) => glob.includes(dir.startsWith('coverage') ? 'coverage*' : dir))).toBe(true);
    }
  });

  it('le balayage des dépendances part des trois pages de l’app seulement (pairing.html : Y-06)', () => {
    expect(config.optimizeDeps?.entries).toEqual(['index.html', 'capture.html', 'pairing.html']);
  });
});
