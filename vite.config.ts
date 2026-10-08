import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { ocrAssets } from './vite.ocrAssets.ts';
// Port partagé avec src-tauri/tauri.conf.json (devUrl, 1420). Seul playwright.config.ts le déplace, par CT_DEV_PORT dans l'environnement
// du serveur qu'il lance (webServer.env) : `npm run dev` et `tauri dev` restent sur 1420, même si CT_E2E_PORT_BASE est posée.
export const DEV_PORT = Number(process.env['CT_DEV_PORT'] ?? 1420);

// Build des mesures de performance (@perf, projet Playwright `perf`) : bundle de PRODUCTION (React en mode production, code minifié) auquel on
// rend les accroches de test de développement (`import.meta.env.DEV` : faux des plateformes, `__ctTest`…). Posé SEULEMENT par la commande de
// build de playwright.config.ts ; jamais dans `npm run build`, `tauri build` ni les workflows de livraison (tests/bundle/e2eHooks.test.ts).
const E2E_HOOKS = process.env['VITE_CT_E2E_HOOKS'] === '1';

export default defineConfig({
  define: E2E_HOOKS ? { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false' } : {},
  plugins: [react(), ocrAssets()],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.claude/**', '**/coverage*/**', '**/test-results/**', '**/playwright-report/**', '**/dist/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Le driver de développement charge son .wasm via import.meta.url : pas de pré-bundling.
  // Le balayage des dépendances ne part que des trois pages de l'app : par défaut Vite parcourt TOUS les .html du dépôt (rapports de
  // couverture, worktrees d'agents : plus de 7 000 fichiers, 12 s au lieu de 2 s) et la première requête attend la fin du balayage.
  optimizeDeps: { entries: ['index.html', 'capture.html', 'pairing.html'], exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    // WebView2 (Chromium) sur Windows, WKWebView (Safari) sur iOS 17+.
    target: ['es2022', 'chrome120', 'safari17'],
    // Trois pages : l'app, la mini-fenêtre de capture rapide (Q-01, capture.html) et la fenêtre de la clé de synchronisation (Y-06,
    // pairing.html : bundle minimal contrôlé par tests/bundle/pairingBundle.test.ts, ADR 0011 section 2.1).
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), capture: resolve(import.meta.dirname, 'capture.html'), pairing: resolve(import.meta.dirname, 'pairing.html') },
    },
    // Cartes de source seulement en debug : l'installeur reste léger (PRD 8 : < 15 Mo).
    sourcemap: !!process.env['TAURI_ENV_DEBUG'] || !process.env['TAURI_ENV_PLATFORM'],
  },
});
