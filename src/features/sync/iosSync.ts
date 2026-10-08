import type { OsFamily } from '../../platform/runtime';

/**
 * Écarts de l'interface de synchro sur iPhone (ADR 0011 §22 points 7 et 8, Y-IOS-01).
 *
 * Les actions qui demandent une confirmation native de l'iPhone (« Oublier le dossier et la clé », « Oublier cet appareil »,
 * « Réinitialiser ») sont masquées tant que cette confirmation n'existe pas (Y-IOS-02) : échec fermé, jamais une action qui échoue sans le
 * dire.
 */
export function nativeConfirmationAvailable(os: OsFamily): boolean {
  return os !== 'ios';
}
