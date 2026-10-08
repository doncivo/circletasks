import type { OsFamily } from '../../platform/runtime';

/**
 * Écarts de l'interface de synchro sur iPhone (ADR 0011 §22 points 7 et 8, §23 point 5).
 *
 * Les actions qui demandent une confirmation native (« Oublier le dossier et la clé », « Oublier cet appareil », « Réinitialiser ») ont
 * leur boîte sur les deux plateformes depuis Y-IOS-02 (`UIAlertController` du plugin folder-bookmark sur iPhone) : plus rien n'est masqué.
 */
export function nativeConfirmationAvailable(os: OsFamily): boolean {
  void os;
  return true;
}
