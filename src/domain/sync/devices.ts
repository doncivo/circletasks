import type { DeviceState } from './compat';

/**
 * Règles d'appareils partagées par le moteur (`src/sync/engine.ts`) et les bandeaux A-09 (`src/domain/syncBanners.ts`,
 * `src/features/sync/startSync.ts`) : une seule source (revue A-09, points 5 et 10). Module pur.
 */

/** Statuts d'un appareil (`DeviceState`, même union que `DeviceSyncStatus` de la plateforme, vérifiée par test). */
export const DEVICE_STATES = ['active', 'expired', 'newer-major', 'clock-ahead', 'corrupt', 'foreign', 'rollback', 'forgotten'] as const satisfies readonly DeviceState[];

/**
 * Statut lu dans `sync_state.status`. Une valeur inconnue (écrite par une version plus récente, ou base abîmée) est signalée comme
 * `corrupt` (« Fichiers illisibles »), jamais rendue `active` : aucun échec silencieux.
 */
export function deviceStateOf(raw: string): DeviceState {
  return (DEVICE_STATES as readonly string[]).includes(raw) ? (raw as DeviceState) : 'corrupt';
}

/** Clé différente : au moins un autre appareil, et aucun autre appareil ne partage la clé locale (tous `foreign`). */
export function keyMismatchFromDevices(devices: readonly { readonly self: boolean; readonly foreign: boolean }[]): boolean {
  const others = devices.filter((d) => !d.self);
  return others.length > 0 && others.every((d) => d.foreign);
}
