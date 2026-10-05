import { createTauriSync } from '../../../platform/sync/tauriSync';
import type { KeyImportResult, PairingPayload, SyncPlatform } from '../../../platform/sync/types';

/**
 * Plateforme réduite de la fenêtre `pairing` (Y-06 critère 17 ; ADR 0011 section 2.1) : trois méthodes seulement, celles que la
 * capability `sync-pairing.json` accorde à cette fenêtre. Les commandes `sync_*` restent appelées par `tauriSync.ts` seul (seule porte
 * vers Rust) ; ce module ne fait que réduire le contrat et choisir l'implémentation :
 * - app installée : `tauriSync` (commandes Rust) ;
 * - navigateur de développement : le faux posé par un test (`globalThis.__ctSync`), sinon la plateforme mémoire, chargée à la demande
 *   et **seulement en développement** (branche retirée du build de production, contrôlé par `test:bundle`).
 *
 * Aucune valeur n'est gardée ici : la clé, le texte du QR et la saisie ne vivent que dans l'état local des composants.
 */
export interface PairingPlatform {
  /** Instance `show` seulement ; `wrong-mode` dans une instance `import`. */
  pairingPayload(o?: { readonly renew: true }): Promise<PairingPayload>;
  /** Détruit la fenêtre appelante (Rust). */
  closePairing(): Promise<void>;
  /** Instance `import` seulement (PC) ; l'entrée est transmise telle quelle, jamais gardée. */
  import(input: { readonly recoveryKey: string }): Promise<KeyImportResult>;
}

/** Réduit une plateforme complète aux trois méthodes de la fenêtre `pairing`. */
export function reducePairingPlatform(key: Pick<SyncPlatform['key'], 'pairingPayload' | 'closePairing' | 'import'>): PairingPlatform {
  return {
    pairingPayload: (o) => key.pairingPayload(o?.renew ? { renew: true } : undefined),
    closePairing: () => key.closePairing(),
    import: (input) => key.import({ recoveryKey: input.recoveryKey }),
  };
}

/** Fenêtre de l'app installée (WebView de Tauri) ? */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Plateforme de la fenêtre `pairing` (voir le module). */
export async function openPairingPlatform(): Promise<PairingPlatform> {
  if (import.meta.env.DEV && !inTauri()) {
    const override = (globalThis as { __ctSync?: SyncPlatform }).__ctSync;
    if (override) return reducePairingPlatform(override.key);
    const { createMemorySyncPlatform } = await import('../../../platform/sync/memory');
    return reducePairingPlatform(createMemorySyncPlatform().key);
  }
  return reducePairingPlatform(createTauriSync({ available: true }).key);
}
