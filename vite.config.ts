import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port fixe partagé avec src-tauri/tauri.conf.json (devUrl) et playwright.config.ts (webServer).
export const DEV_PORT = 1420;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // Le driver de développement charge son .wasm via import.meta.url : pas de pré-bundling.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    // WebView2 (Chromium) sur Windows, WKWebView (Safari) sur iOS 17+.
    target: ['es2022', 'chrome120', 'safari17'],
    // Cartes de source seulement en debug : l'installeur reste léger (PRD 8 : < 15 Mo).
    sourcemap: !!process.env['TAURI_ENV_DEBUG'] || !process.env['TAURI_ENV_PLATFORM'],
  },
});
