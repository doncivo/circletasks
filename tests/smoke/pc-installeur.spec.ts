import { chromium, expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * REL-TECH-02 (audit 1.0 B15, décision 9 d'Ali du 2026-10-17) : la désinstallation ne supprime JAMAIS les données de l'application.
 *
 * L'installeur NSIS de fumée (`npm run test:smoke:installer-build`, produit « CircleTasks Smoke », identifiant `.smoke` : jamais
 * `%LOCALAPPDATA%\CircleTasks` ni `%APPDATA%\fr.circletasks.planner`) est exécuté pour de vrai :
 *   (a) installation silencieuse ; (b) donnée témoin dans `%APPDATA%\fr.circletasks.planner.smoke` ;
 *   (c) même installeur en graphique (messages Win32 postés par `installer-drive.ps1`) : « Désinstaller avant d'installer », case « Supprimer les données
 *       de l'application » COCHÉE et vérifiée, désinstallation, installation jusqu'à « Terminer » ;
 *   (d) la donnée témoin existe toujours, l'application réinstallée démarre ;
 *   (e) `uninstall.exe` en graphique, case cochée : la donnée témoin existe toujours, le dossier d'installation a disparu ;
 *   (f) nettoyage, gardé par l'identifiant `.smoke`.
 * Sans le crochet `NSIS_HOOK_PREUNINSTALL` (src-tauri/windows/hooks.nsh), les pas (c) et (e) effacent la donnée témoin et le test échoue.
 * Aucun état n'est partagé avec pc-demarrage.spec.ts (binaire `--no-bundle`) : ici l'application est celle de l'installation de fumée.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const TAURI_DIR = join(ROOT, 'src-tauri');
const DRIVE_SCRIPT = join(ROOT, 'tests', 'smoke', 'installer-drive.ps1');
const CAPTURE_SCRIPT = join(ROOT, 'tests', 'smoke', 'window-capture.ps1');
const INSTALLER_DIR = join(TAURI_DIR, 'target', 'smoke', 'debug', 'bundle', 'nsis');
/** Seul identifiant dont les dossiers de données peuvent être effacés (ADR 0016). */
const SMOKE_IDENTIFIER = 'fr.circletasks.planner.smoke';
const APP_READY_TIMEOUT_MS = 90_000;
/**
 * Bornes emboîtées (ADR 0016, avenant REL-TECH-02). Durées observées en CI le 2026-10-17 : installation silencieuse et chaque pilotage graphique
 * en quelques secondes, nettoyage en moins d'une seconde ; les bornes laissent une marge d'un ordre de grandeur et ne sont jamais allongées pour
 * faire passer un essai. spawnSync bloque la boucle d'événements : test.setTimeout ne peut rien interrompre, chaque appel porte donc sa borne et le
 * délai du test est la SOMME des bornes (calculée ci-dessous), jamais une valeur indépendante.
 */
const SILENT_INSTALL_TIMEOUT_MS = 120_000;
const DRIVE_TIMEOUT_MS = 300_000;
/** Part de DRIVE_TIMEOUT_MS réservée aux preuves d'échec du pilote : son échéance globale ABSOLUE (-DeadlineEpochMs, calculée juste avant spawnSync : le démarrage de PowerShell est décompté) est DRIVE_TIMEOUT_MS moins cette marge (30 s pour le nettoyage et la capture d'écran, qui n'ont pas de preuves à écrire). */
const DRIVE_EVIDENCE_MARGIN_MS = 295_000;
const CLEANUP_TIMEOUT_MS = 180_000;
const CAPTURE_TIMEOUT_MS = 120_000;
const TASKKILL_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
const INSTALL_DIR_GONE_TIMEOUT_MS = 30_000;
const APP_KILL_TIMEOUT_MS = 15_000;
/** Pire cas cumulé : 2 nettoyages, installation, 2 pilotages, démarrage de l'app (3 attentes + capture), capture d'échec, attentes finales, marge. */
const TEST_TIMEOUT_MS =
  2 * CLEANUP_TIMEOUT_MS + SILENT_INSTALL_TIMEOUT_MS + 2 * DRIVE_TIMEOUT_MS + 3 * APP_READY_TIMEOUT_MS + 2 * CAPTURE_TIMEOUT_MS + SCREENSHOT_TIMEOUT_MS +
  INSTALL_DIR_GONE_TIMEOUT_MS + APP_KILL_TIMEOUT_MS + 3 * TASKKILL_TIMEOUT_MS + 60_000;
const TAURI_ORIGINS = new Set(['http://tauri.localhost', 'tauri://localhost']);

interface DriveResult {
  readonly ok: boolean;
  readonly action: string;
  readonly step: string;
  readonly message: string;
  readonly log: readonly string[];
  readonly files: readonly string[];
}

interface SmokeConf {
  readonly productName: string;
  readonly identifier: string;
  readonly app: { readonly windows: readonly { readonly label: string; readonly additionalBrowserArgs?: string }[] };
}

function readConf(): { productName: string; identifier: string; version: string; cdpPort: number } {
  const smoke = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.smoke.conf.json'), 'utf8')) as SmokeConf;
  const base = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8')) as { version: string };
  const main = smoke.app.windows.find((window) => window.label === 'main');
  const match = /--remote-debugging-port=(\d+)/.exec(main?.additionalBrowserArgs ?? '');
  if (!match?.[1]) throw new Error('aucun --remote-debugging-port dans tauri.smoke.conf.json');
  return { productName: smoke.productName, identifier: smoke.identifier, version: base.version, cdpPort: Number(match[1]) };
}

/** Garde : seul le produit de fumée est installé, désinstallé ou effacé (jamais l'application réelle ni ses données). */
function assertSmokeOnly(productName: string, identifier: string): void {
  if (identifier !== SMOKE_IDENTIFIER) throw new Error(`identifiant ${identifier} : seuls les dossiers de ${SMOKE_IDENTIFIER} peuvent être effacés`);
  if (productName === 'CircleTasks' || !productName.endsWith(' Smoke')) throw new Error(`productName « ${productName} » : un produit « … Smoke » est exigé`);
}

function localAppData(): string {
  const value = process.env['LOCALAPPDATA'];
  if (!value) throw new Error('LOCALAPPDATA indéfini');
  return value;
}

function roamingAppData(): string {
  const value = process.env['APPDATA'];
  if (!value) throw new Error('APPDATA indéfini');
  return value;
}

function runDrive(testInfo: TestInfo, action: 'Reinstall' | 'Uninstall' | 'Cleanup' | 'Screenshot', args: Record<string, string>, timeoutMs: number): DriveResult {
  const resultFile = testInfo.outputPath(`${action.toLowerCase()}-resultat.json`);
  const outDir = testInfo.outputPath('installeur');
  mkdirSync(outDir, { recursive: true });
  rmSync(resultFile, { force: true });
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVE_SCRIPT, '-Action', action, '-OutDir', outDir, '-ResultFile', resultFile, '-DeadlineEpochMs', String(Date.now() + timeoutMs - (action === 'Reinstall' || action === 'Uninstall' ? DRIVE_EVIDENCE_MARGIN_MS : 30_000))];
  // Une valeur vide désigne un paramètre interrupteur (-RemoveRegistry).
  for (const [name, value] of Object.entries(args)) argv.push(...(value === "" ? [`-${name}`] : [`-${name}`, value]));
  const run = spawnSync('powershell', argv, { encoding: 'utf8', timeout: timeoutMs });
  if (!existsSync(resultFile)) {
    return {
      ok: false,
      action,
      step: 'installer-drive.ps1 sans résultat',
      message: `code ${String(run.status)}${run.signal ? `, signal ${run.signal}` : ''}${run.error ? `, ${run.error.message}` : ''} : ${run.stderr}${run.stdout}`,
      log: [],
      files: [],
    };
  }
  return JSON.parse(readFileSync(resultFile, 'utf8')) as DriveResult;
}

async function attachDrive(testInfo: TestInfo, result: DriveResult): Promise<void> {
  await testInfo.attach(`${result.action.toLowerCase()}-journal.txt`, { body: result.log.join('\n'), contentType: 'text/plain' });
  for (const file of result.files) {
    if (!existsSync(file)) continue;
    await testInfo.attach(basename(file), { path: file, contentType: file.endsWith('.png') ? 'image/png' : 'text/plain' });
  }
}

async function driveOrFail(testInfo: TestInfo, action: 'Reinstall' | 'Uninstall', args: Record<string, string>): Promise<DriveResult> {
  const result = runDrive(testInfo, action, args, DRIVE_TIMEOUT_MS);
  await attachDrive(testInfo, result);
  expect(result.ok, `pilotage ${action} échoué à l'étape « ${result.step} » : ${result.message}`).toBe(true);
  return result;
}

function killTree(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: TASKKILL_TIMEOUT_MS });
}

async function cdpReachable(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok;
  } catch {
    return false;
  }
}

/** Le seul `.exe` du dossier d'installation autre que `uninstall.exe` : l'application. */
function installedApp(installDir: string): string {
  const executables = existsSync(installDir) ? readdirSync(installDir).filter((name) => name.toLowerCase().endsWith('.exe') && name.toLowerCase() !== 'uninstall.exe') : [];
  expect(executables, `un seul exécutable d'application attendu dans ${installDir}`).toHaveLength(1);
  return join(installDir, executables[0] ?? '');
}

interface WindowCapture {
  readonly found: boolean;
  readonly visible: boolean;
  readonly iconic: boolean;
  readonly printed: boolean;
}

function captureWindow(pid: number, out: string): WindowCapture {
  const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT, '-ProcessId', String(pid), '-Out', out], { encoding: 'utf8', timeout: CAPTURE_TIMEOUT_MS });
  if (run.status !== 0) throw new Error(`window-capture.ps1 a échoué (code ${String(run.status)}) : ${run.stderr}${run.stdout}`);
  const line = run.stdout
    .split(/\r?\n/)
    .map((text) => text.trim())
    .filter((text) => text.startsWith('{'))
    .at(-1);
  if (!line) throw new Error(`window-capture.ps1 : aucune ligne JSON dans la sortie : ${run.stdout}`);
  return JSON.parse(line) as WindowCapture;
}

test("la désinstallation (réinstallation et uninstall.exe, case « Supprimer les données » cochée) conserve les données de l'application", async () => {
  const testInfo = test.info();
  test.setTimeout(TEST_TIMEOUT_MS);
  const { productName, identifier, version, cdpPort } = readConf();
  assertSmokeOnly(productName, identifier);
  const installDir = join(localAppData(), productName);
  expect(basename(installDir), 'dossier d’installation de fumée').toBe(productName);
  const dataDir = join(roamingAppData(), identifier);
  const localDataDir = join(localAppData(), identifier);
  const marker = join(dataDir, 'smoke-marker.txt');
  const markerContent = `CT-SMOKE ${new Date().toISOString()} ${randomUUID()}\n`;
  const installerCandidates = existsSync(INSTALLER_DIR)
    ? readdirSync(INSTALLER_DIR).filter((name) => name.startsWith(`${productName}_${version}_`) && name.endsWith('-setup.exe'))
    : [];
  expect(installerCandidates, `un seul installeur « ${productName}_${version}_*-setup.exe » attendu dans ${INSTALLER_DIR} (npm run test:smoke:installer-build)`).toHaveLength(1);
  const installer = join(INSTALLER_DIR, installerCandidates[0] ?? '');
  const baseArgs = { ProductName: productName, InstallDir: installDir };
  let app: ChildProcess | undefined;
  let browser: Browser | undefined;

  const cleanup = async (removeRegistry: boolean): Promise<void> => {
    await browser?.close().catch(() => undefined);
    if (app) killTree(app);
    const result = runDrive(testInfo, 'Cleanup', { ...baseArgs, Installer: installer, ...(removeRegistry ? { RemoveRegistry: '' } : {}) }, CLEANUP_TIMEOUT_MS);
    await attachDrive(testInfo, result);
    expect.soft(result.ok, `nettoyage des processus de fumée échoué à l'étape « ${result.step} » : ${result.message}`).toBe(true);
  };

  try {
    // Départ propre : processus, dossiers et clés d'un essai précédent (produit de fumée uniquement).
    await cleanup(true);
    for (const dir of [installDir, dataDir, localDataDir]) {
      if ([productName, identifier].includes(basename(dir))) rmSync(dir, { recursive: true, force: true });
    }
    expect(await cdpReachable(cdpPort), `port CDP ${String(cdpPort)} déjà occupé : une app de fumée précédente tourne encore`).toBe(false);

    await test.step('(a) installation silencieuse (/S)', async () => {
      const run = spawnSync(installer, ['/S'], { encoding: 'utf8', timeout: SILENT_INSTALL_TIMEOUT_MS });
      expect(run.status, `installation silencieuse : code ${String(run.status)} ${run.error?.message ?? ''} ${run.stderr}`).toBe(0);
      expect(existsSync(join(installDir, 'uninstall.exe')), `uninstall.exe absent de ${installDir}`).toBe(true);
      expect(existsSync(installedApp(installDir)), 'application absente après installation').toBe(true);
    });

    await test.step('(b) donnée témoin dans le dossier de données de fumée', () => {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(marker, markerContent, 'utf8');
      expect(readFileSync(marker, 'utf8')).toBe(markerContent);
    });

    await test.step('(c) même installeur en graphique : « Désinstaller avant d’installer », case « Supprimer les données » cochée', async () => {
      await driveOrFail(testInfo, 'Reinstall', { ...baseArgs, Installer: installer });
    });

    await test.step('(d) la donnée témoin existe toujours et l’application réinstallée démarre', async () => {
      expect(existsSync(marker), `donnée témoin supprimée par la désinstallation : ${marker}`).toBe(true);
      expect(readFileSync(marker, 'utf8'), 'contenu de la donnée témoin modifié').toBe(markerContent);
      const exe = installedApp(installDir);
      const output: string[] = [];
      const child = spawn(exe, [], { cwd: installDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
      app = child;
      child.on('error', (error) => output.push(`[spawn] ${error.message}\n`));
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
      let captured = false;
      try {
        await expect
          .poll(async () => (child.exitCode !== null ? 'exited' : (await cdpReachable(cdpPort)) ? 'reachable' : 'waiting'), { message: 'WebView2 de l’application installée injoignable par CDP', timeout: APP_READY_TIMEOUT_MS })
          .not.toBe('waiting');
        expect(child.exitCode, `l'application installée s'est arrêtée (code ${String(child.exitCode)}) : ${output.join('')}`).toBeNull();
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(cdpPort)}`);
        const cdp = browser;
        const mainPage = (): Page | undefined =>
          cdp
            .contexts()
            .flatMap((context) => context.pages())
            .find((page) => {
              const { origin, pathname, search } = new URL(page.url());
              return TAURI_ORIGINS.has(origin) && (pathname === '/' || pathname === '/index.html') && search === '';
            });
        await expect.poll(() => mainPage() !== undefined, { message: 'page principale de l’application installée introuvable', timeout: APP_READY_TIMEOUT_MS }).toBe(true);
        const page = mainPage();
        if (!page) throw new Error('page principale introuvable');
        await expect(page.locator('.app-shell')).toHaveAttribute('data-db-status', 'ready', { timeout: APP_READY_TIMEOUT_MS });
        const capture = captureWindow(child.pid ?? 0, testInfo.outputPath('application-installee.png'));
        captured = true;
        await testInfo.attach('application-installee.json', { body: JSON.stringify(capture), contentType: 'application/json' });
        expect(capture.found, 'fenêtre « CircleTasks » de l’application installée introuvable').toBe(true);
        expect(capture.visible, 'fenêtre de l’application installée invisible').toBe(true);
        expect(capture.iconic, 'fenêtre de l’application installée réduite').toBe(false);
      } finally {
        // Écran noir de l'ADR 0016 : CDP injoignable ou base pas prête. Tant que l'application tourne, sa fenêtre est capturée avant l'arrêt.
        if (!captured && child.exitCode === null) {
          try {
            const failedCapture = captureWindow(child.pid ?? 0, testInfo.outputPath('application-installee-echec.png'));
            await testInfo.attach('application-installee-echec.json', { body: JSON.stringify(failedCapture), contentType: 'application/json' });
            if (existsSync(testInfo.outputPath('application-installee-echec.png'))) await testInfo.attach('application-installee-echec.png', { path: testInfo.outputPath('application-installee-echec.png'), contentType: 'image/png' });
          } catch (error) {
            await testInfo.attach('application-installee-echec.txt', { body: String(error), contentType: 'text/plain' });
          }
        }
        await browser?.close().catch(() => undefined);
        browser = undefined;
        killTree(child);
        await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { message: 'application installée toujours active après taskkill', timeout: APP_KILL_TIMEOUT_MS }).toBe(true);
        if (output.length > 0) await testInfo.attach('application-installee.txt', { body: output.join(''), contentType: 'text/plain' });
        app = undefined;
      }
    });

    await test.step('(e) uninstall.exe en graphique, case cochée : donnée conservée, dossier d’installation supprimé', async () => {
      const uninstaller = join(installDir, 'uninstall.exe');
      expect(existsSync(uninstaller), `uninstall.exe absent : ${uninstaller}`).toBe(true);
      await driveOrFail(testInfo, 'Uninstall', { ...baseArgs, Installer: uninstaller });
      try {
        await expect.poll(() => existsSync(installDir), { message: `dossier d'installation toujours présent : ${installDir}`, timeout: INSTALL_DIR_GONE_TIMEOUT_MS }).toBe(false);
      } catch (error) {
        const shot = runDrive(testInfo, 'Screenshot', { ...baseArgs }, SCREENSHOT_TIMEOUT_MS);
        await attachDrive(testInfo, shot);
        throw error;
      }
      expect(existsSync(marker), `donnée témoin supprimée par uninstall.exe : ${marker}`).toBe(true);
      expect(readFileSync(marker, 'utf8'), 'contenu de la donnée témoin modifié').toBe(markerContent);
    });
  } finally {
    // (f) Nettoyage final : processus, clés de registre et dossiers du seul produit de fumée.
    await cleanup(true);
    for (const dir of [installDir, dataDir, localDataDir]) {
      if ([productName, identifier].includes(basename(dir))) rmSync(dir, { recursive: true, force: true });
    }
  }
});
