import { PAIRING_RESCAN_MS, PAIRING_VALIDITY_MS } from '../../domain/sync/limits';
import { syncErrorCodeOf, type SyncErrorCode, type SyncPlatform } from '../../platform/sync/types';
import type { PlainMessageKey } from '../../i18n';
import type { AppContainer } from '../app/container';
import { JOIN_META } from '../../sync';
import { hubOf, notify, parseJoinView, readMetaResult, storageResult, type JoinView } from './pairingHub';

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
    case 'cloud-pending':
      // Seconde revue, point 2 : l'état d'un appareil actif attend iCloud ; rien n'est refusé pour de bon.
      return mode === 'show' ? 'sync.pairing.openCloudPending' : 'sync.pairing.openFailed';
    case 'state-mismatch':
      // Y-11 (revue 9) : l'ancienne clé est retirée (réinitialisation annoncée ailleurs, ou perdue) : elle n'est plus jamais donnée.
      return mode === 'show' ? 'sync.pairing.openNeedsNewKey' : 'sync.pairing.openFailed';
    case 'window-unprotected':
      // Fenêtre impossible à protéger : texte générique, jamais « Installation incomplète » (remarque finale 4).
      return 'sync.pairing.openFailed';
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
/** Clé de `sync_meta` de l'arrivée en cours : `JOIN_META` du moteur (Y-TECH-02 : une seule constante). */
export { JOIN_META };
// Partie chargée au départ (abonnés, `sync_meta`, arrivée en échec) : `pairingHub.ts`, réexportée ici pour les écrans.
export { onPairingChange, pairingStorageFailed, readJoinFailure, type JoinView, type PairingEvent } from './pairingHub';

export interface PairingFailure {
  readonly mode: 'show' | 'import';
  readonly code: SyncErrorCode;
}

async function readMeta(container: AppContainer, key: string): Promise<unknown> {
  return (await readMetaResult(container, key)).value;
}

async function writeMeta(container: AppContainer, key: string, value: unknown): Promise<void> {
  try {
    await container.data.repos.sync.setMeta(key, value === null ? null : JSON.stringify(value));
    storageResult(container, false);
  } catch {
    storageResult(container, true);
  }
}

export async function readJoinView(container: AppContainer): Promise<JoinView | null> {
  return parseJoinView(await readMeta(container, JOIN_META));
}

export async function readPairingFailure(container: AppContainer): Promise<PairingFailure | null> {
  const value = await readMeta(container, PAIRING_FAILURE_META);
  if (typeof value !== 'object' || value === null) return null;
  const { mode, code } = value as Record<string, unknown>;
  if ((mode !== 'show' && mode !== 'import') || typeof code !== 'string') return null;
  return { mode, code: syncErrorCodeOf({ code }) };
}

// --- abonnés et relance pendant l'affichage --------------------------------------------------------------------------------------

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
  const sync = container.sync;
  if (!sync) return;
  await sync.syncNow('manual');
  // `syncNow` ne rejette jamais : son résultat se lit dans l'état (revue, faible).
  const phase = sync.status().phase;
  notify(container, phase === 'error' || phase === 'key-mismatch' || phase === 'needs-pairing' ? 'paired-sync-failed' : 'changed');
}
