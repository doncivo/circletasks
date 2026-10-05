import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { ocrAssets } from './vite.ocrAssets.ts';

// Port fixe partagé avec src-tauri/tauri.conf.json (devUrl) et playwright.config.ts (webServer).
export const DEV_PORT = 1420;

export default defineConfig({
  plugins: [react(), ocrAssets()],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/.claude/**', '**/coverage*/**', '**/test-results/**', '**/playwright-report/**', '**/dist/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Le driver de développement charge son .wasm via import.meta.url : pas de pré-bundling.
  // Le balayage des dépendances ne part que des deux pages de l'app : par défaut Vite parcourt TOUS les .html du dépôt (rapports de
  // couverture, worktrees d'agents : plus de 7 000 fichiers, 12 s au lieu de 2 s) et la première requête attend la fin du balayage.
  optimizeDeps: { entries: ['index.html', 'capture.html'], exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    // WebView2 (Chromium) sur Windows, WKWebView (Safari) sur iOS 17+.
    target: ['es2022', 'chrome120', 'safari17'],
    // Deux pages : l'app et la mini-fenêtre de capture rapide (Q-01, capture.html).
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), capture: resolve(import.meta.dirname, 'capture.html') } },
    // Cartes de source seulement en debug : l'installeur reste léger (PRD 8 : < 15 Mo).
    sourcemap: !!process.env['TAURI_ENV_DEBUG'] || !process.env['TAURI_ENV_PLATFORM'],
  },
});
