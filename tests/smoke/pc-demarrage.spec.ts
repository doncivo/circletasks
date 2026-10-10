import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { formatTodayHeader } from '../../src/i18n/format';
import { fr } from '../../src/i18n/fr';

/**
 * REL-TECH-01 (ADR 0016) : test de fumée du VRAI binaire Windows. Le binaire `circletasks.exe` (build debug, front embarqué, identifiant de
 * fumée, dossier cargo dédié `target/smoke` : `npm run test:smoke:build`) est lancé sur un dossier de données neuf ; la WebView2 est observée
 * par CDP (port de `src-tauri/tauri.smoke.conf.json`) ; puis les pixels réels de la fenêtre Win32 sont capturés (PrintWindow,
 * `window-capture.ps1`). Les deux niveaux sont bloquants : le 2026-10-10, le DOM était complet et la fenêtre entièrement noire.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const CONF_PATH = join(ROOT, 'src-tauri', 'tauri.smoke.conf.json');
const CAPTURE_SCRIPT = join(ROOT, 'tests', 'smoke', 'window-capture.ps1');
const BINARY = join(ROOT, 'src-tauri', 'target', 'smoke', 'debug', 'circletasks.exe');
/** Seul identifiant dont les dossiers de données peuvent être effacés (ADR 0016). */
const SMOKE_IDENTIFIER = 'fr.circletasks.planner.smoke';
/** Démarrage complet de l'app (base neuve, migrations, écrans) sur un runner chargé. */
const APP_READY_TIMEOUT_MS = 90_000;
/** Part maximale de pixels quasi noirs admise dans la zone cliente (fenêtre noire du 2026-10-10 : 100 %). */
const MAX_NEAR_BLACK_RATIO = 0.95;
/** Origines des ressources embarquées par Tauri (Windows : `http://tauri.localhost` ; `tauri://localhost` ailleurs) : jamais un serveur Vite. */
const TAURI_ORIGINS = new Set(['http://tauri.localhost', 'tauri://localhost']);

interface SmokeConf {
  readonly identifier: string;
  readonly app: { readonly windows: readonly { readonly label: string; readonly additionalBrowserArgs?: string }[] };
}

interface CaptureStats {
  readonly sampled: number;
  readonly nearBlack: number;
  readonly distinct: number;
}

interface WindowCapture extends CaptureStats {
  readonly found: boolean;
  readonly visible: boolean;
  readonly iconic: boolean;
  readonly width: number;
  readonly height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly printed: boolean;
}

function readConf(): { identifier: string; cdpPort: number } {
  const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8')) as SmokeConf;
  const main = conf.app.windows.find((window) => window.label === 'main');
  const match = /--remote-debugging-port=(\d+)/.exec(main?.additionalBrowserArgs ?? '');
  if (!match?.[1]) throw new Error(`${CONF_PATH} : aucun --remote-debugging-port dans additionalBrowserArgs de la fenêtre main`);
  return { identifier: conf.identifier, cdpPort: Number(match[1]) };
}

/** Dossiers de données de l'app de fumée (identifiant dédié : jamais ceux de l'app installée ni de l'app de dev). */
function dataDirs(identifier: string): string[] {
  if (identifier !== SMOKE_IDENTIFIER) throw new Error(`identifiant ${identifier} : seuls les dossiers de ${SMOKE_IDENTIFIER} peuvent être effacés`);
  const dirs: string[] = [];
  for (const base of [process.env['APPDATA'], process.env['LOCALAPPDATA']]) {
    if (base) dirs.push(join(base, identifier));
  }
  return dirs.filter((dir) => basename(dir) === SMOKE_IDENTIFIER);
}

function runPowerShell(args: readonly string[]): string {
  const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT, ...args], { encoding: 'utf8', timeout: 60_000 });
  if (run.status !== 0) throw new Error(`window-capture.ps1 a échoué (code ${String(run.status)}) : ${run.stderr}${run.stdout}`);
  const line = run.stdout
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`window-capture.ps1 : aucune ligne JSON dans la sortie : ${run.stdout}`);
  return line;
}

async function cdpReachable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
  }
}

test('le contrôle des pixels voit une image noire, même sous une barre de titre claire, et accepte le thème sombre de l’app (preuve du détecteur)', () => {
  const result = JSON.parse(runPowerShell(['-SelfTest'])) as { black: CaptureStats; barredWhole: CaptureStats; barredClient: CaptureStats; app: CaptureStats };
  expect(result.black.sampled).toBeGreaterThan(1000);
  expect(result.black.nearBlack).toBe(result.black.sampled);
  expect(result.black.distinct).toBe(1);
  // Fenêtre noire sous une barre de titre claire : la fenêtre entière frôle le seuil, la zone cliente (celle que mesure le test) est noire à 100 %.
  expect(result.barredWhole.nearBlack / result.barredWhole.sampled).toBeGreaterThan(MAX_NEAR_BLACK_RATIO);
  expect(result.barredClient.nearBlack).toBe(result.barredClient.sampled);
  expect(result.app.sampled).toBe(result.black.sampled);
  expect(result.app.nearBlack).toBe(0);
  expect(result.app.distinct).toBeGreaterThanOrEqual(2);
});

test('le binaire Windows démarre sur une base neuve et affiche l’écran du jour, à l’écran et pas seulement dans le DOM', async () => {
  const testInfo = test.info();
  test.setTimeout(240_000);
  const { identifier, cdpPort } = readConf();
  expect(existsSync(BINARY), `binaire absent : ${BINARY} (lancer npm run test:smoke:build)`).toBe(true);
  expect(await cdpReachable(cdpPort), `port CDP ${String(cdpPort)} déjà occupé : une app de fumée précédente tourne encore`).toBe(false);
  // Premier lancement réel : dossier de données neuf (dossiers de l'identifiant de fumée seulement).
  for (const dir of dataDirs(identifier)) rmSync(dir, { recursive: true, force: true });

  const output: string[] = [];
  const app = spawn(BINARY, [], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  app.on('error', (error) => output.push(`[spawn] ${error.message}\n`));
  app.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  app.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exited = (): string =>
    `le binaire s'est arrêté (code ${String(app.exitCode)}) : autre instance au même identifiant ? binaire construit sans tauri.smoke.conf.json ? ${output.join('')}`;
  const capturePath = testInfo.outputPath('fenetre.png');
  let browser: Browser | undefined;
  try {
    // Attente de la WebView, arrêtée dès que le binaire se termine (une autre instance au même identifiant : sortie silencieuse, code 0).
    await expect
      .poll(async () => (app.exitCode !== null ? 'exited' : (await cdpReachable(cdpPort)) ? 'reachable' : 'waiting'), { message: 'WebView2 injoignable par CDP', timeout: APP_READY_TIMEOUT_MS })
      .not.toBe('waiting');
    expect(app.exitCode, exited()).toBeNull();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(cdpPort)}`);
    const cdp = browser;
    // Page principale : origine Tauri (ressources embarquées, jamais un serveur Vite), racine sans paramètre (la fenêtre Capture rapide a sa page).
    const mainPage = (): Page | undefined =>
      cdp
        .contexts()
        .flatMap((context) => context.pages())
        .find((page) => {
          const { origin, pathname, search } = new URL(page.url());
          return TAURI_ORIGINS.has(origin) && (pathname === '/' || pathname === '/index.html') && search === '';
        });
    await expect.poll(() => mainPage() !== undefined, { message: 'page principale introuvable parmi les cibles CDP (origine Tauri attendue)', timeout: APP_READY_TIMEOUT_MS }).toBe(true);
    const page = mainPage();
    if (!page) throw new Error('page principale introuvable');

    // 1. Le DOM : démarrage complet (base ouverte, migrations, conteneur), aucun échec affiché.
    await expect(page.locator('.app-shell')).toHaveAttribute('data-db-status', 'ready', { timeout: APP_READY_TIMEOUT_MS });
    await expect(page.getByRole('navigation')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Base neuve dans l'app installée : le guide de bienvenue (P-05) s'affiche toujours, parfois après « ready » ; attendu puis passé.
    const guide = page.getByRole('dialog', { name: fr.onboarding.dialogLabel });
    await expect(guide).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
    await guide.getByRole('button', { name: fr.onboarding.skipLabel }).click();
    await expect(guide).toHaveCount(0);
    // Écran du jour (A-01) : onglet Tâches courant, titre du jour local de la machine formaté comme l'écran (PC : style long), badge.
    await expect(page.getByRole('navigation').locator('[aria-current="page"]')).toContainText(fr.nav.tabs.tasks);
    const heading = page.getByRole('heading', { level: 1 }).first();
    await expect(heading).toBeVisible();
    const today = new Date();
    const localIso = new Date(today.getTime() - today.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    await expect(heading).toHaveText(formatTodayHeader(localIso, 'long').dayLine);
    await expect(page.getByText(fr.tasks.todayBadge, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(app.exitCode, exited()).toBeNull();
    await testInfo.attach('dom.png', { body: await page.screenshot(), contentType: 'image/png' });

    // 2. Les pixels : la fenêtre Win32 existe, est visible, non réduite ; sa zone cliente (sans cadre ni barre de titre) n'est pas noire.
    const capture = JSON.parse(runPowerShell(['-ProcessId', String(app.pid), '-Out', capturePath])) as WindowCapture;
    expect(capture.found, 'fenêtre « CircleTasks » introuvable pour le processus').toBe(true);
    expect(capture.visible, 'fenêtre principale invisible').toBe(true);
    expect(capture.iconic, 'fenêtre principale réduite').toBe(false);
    expect(capture.clientWidth, 'largeur de la zone cliente').toBeGreaterThanOrEqual(1024);
    expect(capture.clientHeight, 'hauteur de la zone cliente').toBeGreaterThanOrEqual(700);
    expect(capture.printed, 'PrintWindow a échoué (session Windows non interactive ?)').toBe(true);
    expect(capture.sampled).toBeGreaterThan(1000);
    const ratio = capture.nearBlack / capture.sampled;
    expect(ratio, `fenêtre noire : ${String(capture.nearBlack)} pixels quasi noirs sur ${String(capture.sampled)}`).toBeLessThan(MAX_NEAR_BLACK_RATIO);
    expect(capture.distinct, 'fenêtre d’une seule couleur').toBeGreaterThanOrEqual(2);
    expect(app.exitCode, exited()).toBeNull();
  } finally {
    if (existsSync(capturePath)) await testInfo.attach('fenetre.png', { path: capturePath, contentType: 'image/png' });
    await browser?.close().catch(() => undefined);
    killTree(app);
    // L'app se cache dans la zone de notification à la fermeture : sa fin est attendue et vérifiée (jamais un circletasks.exe de fumée qui reste).
    await expect.poll(() => app.exitCode !== null || app.signalCode !== null, { message: 'binaire de fumée toujours actif après taskkill', timeout: 15_000 }).toBe(true);
    if (output.length > 0) await testInfo.attach('binaire.txt', { body: output.join(''), contentType: 'text/plain' });
  }
});
