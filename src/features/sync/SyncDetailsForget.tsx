import type { SyncDeviceStatus } from '../../platform/sync/types';

/**
 * Emplacement « oubli d'un appareil » de l'écran de détails de la synchro (Y-10, étape 0 du lot Y4) : vide pour l'instant ; Y-10 le
 * remplit dans ce fichier seulement (échec persistant `sync_meta.forgetFailure`, suppression en attente), sans toucher
 * `SyncDetailsScreen.tsx`.
 */
export function SyncDetailsForget() {
  return null;
}

/**
 * Action de la ligne d'un **autre** appareil dans APPAREILS (Y-10, étape 0 du lot Y4 : « Oublier cet appareil », « Oublié · suppression
 * des fichiers en attente… ») : vide pour l'instant ; jamais rendue pour l'appareil local.
 */
export function SyncDeviceForgetAction(_props: { readonly device: SyncDeviceStatus }) {
  return null;
}
