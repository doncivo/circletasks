import { PAIRING_RESCAN_MS, PAIRING_VALIDITY_MS } from '../../domain/sync/limits';
import { syncErrorCodeOf, type SyncErrorCode, type SyncPlatform } from '../../platform/sync/types';
import type { PlainMessageKey } from '../../i18n';
import type { AppContainer } from '../app/container';

/**
 * Texte d'un échec d'ouverture de la fenêtre `pairing` (jamais une boîte bloquante, Y-06 critère 4). Codes distincts (revue 2) :
 * `not-foreground` (application pas au premier plan, aucune boîte), `already-open`, `consent-denied` (refus de la boîte, mode `show`
 * seulement ; texte neutre en mode `import`, qui n'ouvre pas de boîte).
 */
export function pairingOpenErrorKey(code: SyncErrorCode, mode: 'show' | 'import'): PlainMessageKey {
  switch (code) {
    case 'consent-denied':
      return mode === 'show' ? 'sync.pairing.openDenied' : 'sync.pairing.importCancelled';
    case 'not-foreground':
      return 'sync.pairing.openBackground';
    case 'already-open':
      return 'sync.pairing.openAlreadyOpen';
    case 'rate-limited':
      return 'sync.pairing.openRateLimited';
    case 'io':
      return 'sync.pairing.openIncomplete';
    default:
      return 'sync.pairing.openFailed';
  }
}

/**
 * État de l'association vu par la fenêtre principale (Y-06 ; exigence d'Ali : tout échec qui peut bloquer est visible, persiste après
 * un redémarrage tant qu'il n'est pas résolu et s'efface à la réussite). Rien de sensible ici : des codes et des compteurs.
 *
 * - `sync_meta.pairingFailure` : dernier échec d'ouverture de la fenêtre `pairing` (installation incomplète, trop de demandes…), effacé
 *   à la prochaine ouverture réussie ou à l'association. Un refus de la boîte de confirmation est un choix, pas un échec : jamais gardé.
 * - `sync_meta.join` : écrit par le moteur (`src/sync/join.ts`) pendant l'arrivée d'un nouvel appareil ; lu ici pour l'afficher.
 * - Arrivée (`sync-paired`) : `main` relance un cycle (Rust a déjà détruit la fenêtre) ; les écrans abonnés rafraîchissent leur ligne.
 * - Pendant l'affichage du QR, `main` relance un cycle toutes les 10 s (le scan de Rust détecte l'arrivée), 5 minutes au plus.
 */

/** Clé de `sync_meta` de l'échec d'ouverture (table locale, jamais publiée). */
export const PAIRING_FAILURE_META = 'pairingFailure';
/** Clé de `sync_meta` de l'arrivée en cours ; identique à `JOIN_META` de `src/sync/join.ts` (vérifié par un test). */
export const JOIN_STATE_META = 'join';

export interface PairingFailure {
  readonly mode: 'show' | 'import';
  readonly code: SyncErrorCode;
}

export interface JoinView {
  readonly done: number;
  readonly total: number;
  readonly failure: string | null;
}

async function readMeta(container: AppContainer, key: string): Promise<unknown> {
  try {
    const raw = await container.data.repos.sync.getMeta(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

async function writeMeta(container: AppContainer, key: string, value: unknown): Promise<void> {
  try {
    await container.data.repos.sync.setMeta(key, value === null ? null : JSON.stringify(value));
  } catch {
    // base indisponible : l'échec reste affiché pour cette session
  }
}

export async function readPairingFailure(container: AppContainer): Promise<PairingFailure | null> {
  const value = await readMeta(container, PAIRING_FAILURE_META);
  if (typeof value !== 'object' || value === null) return null;
  const { mode, code } = value as Record<string, unknown>;
  if ((mode !== 'show' && mode !== 'import') || typeof code !== 'string') return null;
  return { mode, code: syncErrorCodeOf({ code }) };
}

export async function readJoinView(container: AppContainer): Promise<JoinView | null> {
  const value = await readMeta(container, JOIN_STATE_META);
  if (typeof value !== 'object' || value === null) return null;
  const { done, total, failure } = value as Record<string, unknown>;
  if (typeof done !== 'number' || typeof total !== 'number') return null;
  return { done, total, failure: typeof failure === 'string' ? failure : null };
}

// --- abonnés et relance pendant l'affichage --------------------------------------------------------------------------------------

interface PairingHub {
  readonly listeners: Set<(event: PairingEvent) => void>;
  stopWatch: (() => void) | null;
}

const hubs = new WeakMap<AppContainer, PairingHub>();

function hubOf(container: AppContainer): PairingHub {
  let hub = hubs.get(container);
  if (!hub) {
    hub = { listeners: new Set(), stopWatch: null };
    hubs.set(container, hub);
  }
  return hub;
}

/** `changed` : échec gardé ou effacé ; `paired` : appareil associé (`sync-paired`). */
export type PairingEvent = 'changed' | 'paired';

/** Changement de l'état d'association ; renvoie le désabonnement. */
export function onPairingChange(container: AppContainer, listener: (event: PairingEvent) => void): () => void {
  const hub = hubOf(container);
  hub.listeners.add(listener);
  return () => hub.listeners.delete(listener);
}

function notify(container: AppContainer, event: PairingEvent = 'changed'): void {
  for (const listener of hubOf(container).listeners) listener(event);
}

/**
 * Ouvre la fenêtre `pairing` depuis `main`. Réussite : échec gardé effacé ; en mode `show`, relance d'un cycle toutes les 10 s pendant
 * la validité du code. Échec : code renvoyé (texte choisi par l'écran) et gardé s'il ne s'agit pas d'un simple refus.
 */
export async function openPairingWindow(container: AppContainer, mode: 'show' | 'import', platform: SyncPlatform | null = container.syncPlatform): Promise<SyncErrorCode | null> {
  if (!platform) return 'not-configured';
  try {
    await platform.key.openPairing(mode);
  } catch (error) {
    const code = syncErrorCodeOf(error);
    // Un refus de la boîte, une application pas au premier plan ou une fenêtre déjà ouverte ne sont pas des pannes : jamais gardés.
    if (code !== 'consent-denied' && code !== 'not-foreground' && code !== 'already-open') await writeMeta(container, PAIRING_FAILURE_META, { mode, code } satisfies PairingFailure);
    notify(container);
    return code;
  }
  await writeMeta(container, PAIRING_FAILURE_META, null);
  if (mode === 'show') watchArrival(container);
  notify(container);
  return null;
}

/** Relance de cycles pendant l'affichage du QR (le scan de Rust détecte l'appareil qui arrive), 5 minutes au plus. */
function watchArrival(container: AppContainer): void {
  const hub = hubOf(container);
  hub.stopWatch?.();
  const sync = container.sync;
  if (!sync) return;
  let elapsed = 0;
  const halt = (): void => {
    clearInterval(timer);
    if (hub.stopWatch === halt) hub.stopWatch = null;
  };
  const timer = setInterval(() => {
    elapsed += PAIRING_RESCAN_MS;
    void sync.syncNow('timer');
    if (elapsed >= PAIRING_VALIDITY_MS) halt();
  }, PAIRING_RESCAN_MS);
  hub.stopWatch = halt;
}

/** Relance de cycles en cours (tests). */
export function arrivalWatchActive(container: AppContainer): boolean {
  return hubOf(container).stopWatch !== null;
}

/** `sync-paired` reçu (Rust a détruit la fenêtre) : relance arrêtée, échec effacé, cycle lancé, écrans prévenus. */
export async function handleSyncPaired(container: AppContainer): Promise<void> {
  const hub = hubOf(container);
  hub.stopWatch?.();
  hub.stopWatch = null;
  await writeMeta(container, PAIRING_FAILURE_META, null);
  notify(container, 'paired');
  await container.sync?.syncNow('manual');
  notify(container);
}
