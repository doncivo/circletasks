import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { E2E_SYNC_SIM_PORT, simUrl } from '../../sim/ports';
import { APP_READY_TIMEOUT_MS, waitForScreenLoaded } from './app';

/**
 * Aides e2e de la synchro (Y-04, parcours 10 à deux pages) : pages du navigateur de dev reliées au simulateur de dossier
 * (`tests/sim/syncFolderSim.ts`, port fixe lancé par `globalSetup`), « iCloud » piloté par le test, écran Réglages › Synchronisation ›
 * Détails. Chaque test a son espace (`room`) dans le simulateur.
 */

export const SYNC_SIM_URL = simUrl(E2E_SYNC_SIM_PORT);

/** iPhone 16 Pro Max dans Chromium (projet `iphone` de playwright.config.ts), avec un agent iOS : l'appareil publie la plateforme `ios`. */
const IPHONE_CONTEXT = {
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
} as const;
/** PC (projet `pc`), avec un agent Windows quel que soit le système qui lance les tests : l'appareil publie la plateforme `windows`. */
const PC_CONTEXT = {
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
} as const;

export interface SyncedPage {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly device: 'pc' | 'iphone';
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${SYNC_SIM_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`simulateur de dossier : ${path} → ${String(response.status)}`);
  return (await response.json()) as T;
}

/**
 * Ouvre l'app dans un nouveau contexte (base neuve) relié au simulateur : `first` choisit le dossier et crée la clé ; `join` est associé
 * au premier (qui doit déjà avoir synchronisé une fois) ; `bare` reçoit le dossier du premier sans clé (association par l'app, Y-06).
 */
export async function openSyncedPage(browser: Browser, room: string, device: string, role: 'first' | 'join' | 'bare' | 'nofolder', kind: 'pc' | 'iphone' = device === 'iphone' ? 'iphone' : 'pc'): Promise<SyncedPage> {
  const context = await browser.newContext({ ...(kind === 'pc' ? PC_CONTEXT : IPHONE_CONTEXT), locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await context.newPage();
  await page.addInitScript((config) => {
    (globalThis as { __ctSyncSim?: unknown }).__ctSyncSim = config;
  }, { url: SYNC_SIM_URL, room, device, role, platform: kind === 'pc' ? 'windows' : 'ios' });
  await page.goto('/');
  await expect(page.getByRole('navigation')).toBeVisible({ timeout: APP_READY_TIMEOUT_MS });
  return { page, context, device: kind };
}

/** « iCloud » recopie les dossiers de tous les appareils de l'espace (retour en ligne). */
export const propagate = (room: string): Promise<unknown> => post('/propagate', { room });

/** La méthode de plateforme de l'appareil échouera (code donné, avant toute écriture) après `after` appels réussis. */
export const failAfter = (room: string, device: string, method: string, after: number, code = 'io'): Promise<unknown> => post('/fail', { room, device, method, after, code });

/** Y-IOS-02 : le prochain scan de l'iPhone `device` lira le QR affiché par `from` (texte produit par le simulateur, jamais par la page). */
export const presentQr = (room: string, device: string, from: string): Promise<unknown> => post('/scan', { room, device, from });

/** Y-IOS-02 (QA du parcours) : le prochain scan lit ce texte à la place du QR (`null` : scan annulé). Texte choisi par le test, jamais par la page. */
export const presentText = (room: string, device: string, text: string | null): Promise<unknown> => post('/scan', { room, device, text });

/** Y-IOS-02 (QA du parcours) : crochet de la plateforme simulée de l'appareil (Trousseau verrouillé, application en arrière-plan, confirmation refusée). */
export const setTesting = (room: string, device: string, call: 'setVaultAvailable' | 'setForeground' | 'setConsent', value: boolean): Promise<unknown> => post('/testing', { room, device, call, args: [value] });

/** Y-IOS-02 : autorisation de la caméra simulée de l'iPhone (`answer` : réponse à la demande d'iOS) ; rend les ouvertures des réglages. */
export const setCamera = (room: string, device: string, state: 'granted' | 'denied' | 'prompt', answer?: 'granted' | 'denied'): Promise<{ readonly opened: number }> =>
  post('/camera', { room, device, state, ...(answer ? { answer } : {}) });

/** Y-IOS-01 : dossier rendu injoignable (signet perdu) ou rétabli. */
export const setUnreachable = (room: string, device: string, on: boolean): Promise<unknown> => post('/unreachable', { room, device, on });

export interface SimInspection {
  readonly deviceId: string | null;
  readonly appends: number;
  /** Y-IOS-01 : `hydrateBudgetMs` reçu par chaque scan (null : absent). */
  readonly scanBudgets: readonly (number | null)[];
  /** Tâches publiées par l'appareil : nombre de créations complètes par identifiant. */
  readonly tasks: Readonly<Record<string, number>>;
  readonly failing: boolean;
}

export const inspect = (room: string, device: string): Promise<SimInspection> => post('/inspect', { room, device });

export const closeRoom = (room: string): Promise<unknown> => post('/close-room', { room });

/** Réglages › Synchronisation › Détails (l'onglet Réglages rouvre le dernier écran visité : les détails, ou l'accueil de Réglages). */
export async function openSyncDetails(page: Page): Promise<void> {
  await waitForScreenLoaded(page, 'settingsscreen');
  await waitForScreenLoaded(page, 'syncdetailsscreen');
  await page.getByRole('navigation').getByText('Réglages', { exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Synchronisation', level: 1 });
  const details = page.getByRole('button', { name: 'Détails', exact: true });
  await expect(heading.or(details)).toBeVisible();
  if (!(await heading.isVisible())) await details.click();
  await expect(heading).toBeVisible();
}

/** Ligne d'état de la synchro (sous-ligne, sans rôle : l'annonce se fait par la région vivante séparée). */
export const syncStatusLine = (page: Page): Locator => page.locator('.ct-sync__sub');

/** « Synchroniser » depuis les détails, puis attend la fin du cycle (bouton revenu, état final). */
export async function syncNow(page: Page, expected: RegExp = /^À jour/): Promise<void> {
  const button = page.getByRole('button', { name: 'Synchroniser', exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByRole('button', { name: 'Synchroniser', exact: true })).toBeEnabled({ timeout: APP_READY_TIMEOUT_MS });
  await expect(syncStatusLine(page)).toHaveText(expected);
}

/** Liste du journal des conflits et ses lignes. */
export const conflictList = (page: Page): Locator => page.getByRole('list', { name: 'Journal des conflits' });
export const conflictItems = (page: Page): Locator => conflictList(page).getByRole('listitem');

/** Onglet Tâches. */
export async function openTasks(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('button', { name: 'Tâches', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

/** Ligne d'une tâche de la liste du jour, par son titre exact. */
export const taskRow = (page: Page, title: string): Locator => page.locator('.ct-list-row').filter({ has: page.getByRole('button', { name: title, exact: true }) });

/**
 * Fenêtre dédiée `pairing` (Y-06, parcours 11) : `pairing.html` servie par Vite, dans le contexte de l'appareil donné. Sa plateforme
 * réduite (trois méthodes) est posée en `__ctSync` par le test et adossée au simulateur de dossier : comme Rust, le simulateur tient
 * l'instance ouverte par la fenêtre principale (`openPairing`) et refuse tout appel sans elle.
 */
export async function openPairingWindow(context: BrowserContext, room: string, device: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript((config) => {
    const call = async (path: string, args: unknown[]): Promise<unknown> => {
      const response = await fetch(`${config.url}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ room: config.room, device: config.device, role: 'first', platform: 'windows', path, args }),
      });
      const reply = (await response.json()) as { ok?: unknown; error?: { code?: string; message?: string } };
      if (reply.error) throw Object.assign(new Error('simulateur'), { code: reply.error.code });
      return reply.ok;
    };
    (globalThis as { __ctSync?: unknown }).__ctSync = {
      key: {
        pairingPayload: (o?: { renew: true }) => call('key.pairingPayload', o ? [o] : []),
        closePairing: () => call('key.closePairing', []),
        import: (input: unknown) => call('key.import', [input]),
      },
    };
  }, { url: SYNC_SIM_URL, room, device });
  await page.goto('/pairing.html');
  return page;
}
