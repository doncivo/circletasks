import base from './playwright.config';
import { defineConfig } from '@playwright/test';
export default defineConfig({ ...base, webServer: { command: 'npx vite preview --outDir dist-perf --port 50020 --strictPort', url: 'http://localhost:50020', reuseExistingServer: false, timeout: 60_000 }, projects: base.projects?.map((p) => ({ ...p, use: { ...p.use, baseURL: 'http://localhost:50020' } })), globalSetup: undefined });
