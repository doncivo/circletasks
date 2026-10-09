import type { SyncErrorCode } from './format';

/**
 * Famille d'un code d'erreur de synchro (Y-IOS-02, audit des impasses, point de contrôle d'Ali 0.2.1) : dit si un nouveau cycle peut
 * résoudre l'erreur et quelle action la résout. « Nouvel essai au prochain cycle » n'est dit que pour une erreur passagère (espacée après
 * `SLOW_AFTER` échecs de suite, jamais arrêtée) ; une erreur permanente dit son action et son code, et le planificateur ne relance plus de
 * cycle périodique pour elle (ouverture, retour au premier plan, masquage, « Quitter » et « Synchroniser » relisent l'état).
 *
 * - `transient` : passagère (iCloud, coffre verrouillé, fichier partiellement synchronisé, refus ou limite de l'utilisateur…).
 * - `pairing` : la clé manque ou n'est pas celle du dossier : associer cet appareil.
 * - `folder` : le dossier est à choisir de nouveau (non lié, inutilisable).
 * - `reset` : la clé ne peut plus servir : réinitialiser la synchronisation (Détails).
 * - `update` : format plus récent : mettre à jour l'app.
 * - `details` : erreur permanente sans action propre (base, fichier illisible, erreur interne) : code affiché, Détails.
 */
export type SyncErrorFamily = 'transient' | 'pairing' | 'folder' | 'reset' | 'update' | 'details';

const FAMILIES: { readonly [C in SyncErrorCode]: SyncErrorFamily } = {
  'not-configured': 'folder',
  'folder-unreachable': 'transient',
  'unsafe-folder': 'folder',
  'not-local': 'transient',
  'folder-too-large': 'folder',
  'cloud-pending': 'transient',
  'cloud-provider-stopped': 'transient',
  'cloud-error': 'transient',
  'vault-unavailable': 'transient',
  'key-missing': 'pairing',
  'key-exists': 'details',
  'key-mismatch': 'pairing',
  'key-exhausted': 'reset',
  'consent-denied': 'transient',
  'rate-limited': 'transient',
  'not-foreground': 'transient',
  'already-open': 'transient',
  'window-unprotected': 'details',
  'decrypt-failed': 'details',
  // Fichier partiellement synchronisé par iCloud : complété par iCloud, relu au cycle suivant.
  truncated: 'transient',
  'bad-name': 'details',
  'bad-header': 'details',
  'too-large': 'details',
  'newer-format': 'update',
  rollback: 'details',
  // Réessayés dans le cycle (publisher.ts, ouverture de `max + 1`), puis au cycle suivant après un nouveau scan : passagers.
  'segment-mismatch': 'transient',
  'segment-full': 'transient',
  // Hypothèse d'écriture refusée (un autre appareil a écrit entre-temps) : relue au cycle suivant.
  'state-mismatch': 'transient',
  'folder-has-data': 'pairing',
  'wrong-window': 'details',
  'wrong-mode': 'details',
  'hlc-order': 'details',
  'invalid-pairing': 'pairing',
  'pairing-expired': 'pairing',
  'not-bound': 'folder',
  'already-bound': 'folder',
  'current-epoch': 'details',
  // Sur PC, iCloud occupe souvent un fichier un instant (jusqu'à une dizaine de minutes) : passagère, jamais arrêtée.
  io: 'transient',
};

/**
 * Erreur passagère répétée : après `SLOW_AFTER` échecs consécutifs du même code, les cycles périodiques sont espacés de
 * `SLOW_RETRY_MS` (jamais arrêtés) et la ligne dit « ralentie : nouvel essai à HH:MM (code …) ».
 */
export const SLOW_AFTER = 3;
export const SLOW_RETRY_MS = 30 * 60_000;

export function syncErrorFamily(code: SyncErrorCode | null | undefined): SyncErrorFamily {
  if (!code) return 'transient';
  return FAMILIES[code] ?? 'details';
}

/** Erreur qu'un cycle périodique ne résoudra pas : aucune relance périodique (ouverture, retour au premier plan et « Synchroniser » relisent). */
export function isPermanentSyncError(code: SyncErrorCode | null | undefined): boolean {
  return code !== null && code !== undefined && syncErrorFamily(code) !== 'transient';
}

/** Erreur passagère répétée `SLOW_AFTER` fois de suite : nouvel essai espacé. */
export function isSlowedSyncError(code: SyncErrorCode | null | undefined, streak: number): boolean {
  return code !== null && code !== undefined && syncErrorFamily(code) === 'transient' && streak >= SLOW_AFTER;
}
