import { getLocale } from './index';

/**
 * Textes des actions de secours de la synchro (Détails › AVERTISSEMENTS : « Démarrer la synchro depuis cet appareil », « Lancer une reprise
 * complète »). Catalogue à part, importé seulement par `SyncDetailsRescue` (bloc à la demande) : ces textes rares ne pèsent pas dans le
 * JavaScript de départ. Clés typées ; l'anglais est servi quand la langue courante est `en`, sinon le français.
 */
const fr = {
  startHere: 'Démarrer la synchro depuis cet appareil',
  startHereTitle: 'Démarrer la synchro depuis cet appareil ?',
  startHereBody: 'À utiliser seulement si vos autres appareils ne sont plus disponibles. Cet appareil devient le point de départ : les autres appareils fusionneront ensuite leurs données dans celui-ci.',
  fullResume: 'Lancer une reprise complète',
  fullResumeTitle: 'Lancer une reprise complète ?',
  fullResumeBody: 'Les données reçues sont relues depuis le dernier instantané et fusionnées avec celles de cet appareil ; rien n’est effacé. Une ligne supprimée sur cet appareil n’est pas recréée.',
} as const;

const en: Record<keyof typeof fr, string> = {
  startHere: 'Start syncing from this device',
  startHereTitle: 'Start syncing from this device?',
  startHereBody: 'Only use this if your other devices are no longer available. This device becomes the starting point: the other devices will then merge their data into it.',
  fullResume: 'Run a full resume',
  fullResumeTitle: 'Run a full resume?',
  fullResumeBody: 'Received data is read again from the latest snapshot and merged with this device’s data; nothing is erased. A row deleted on this device is not recreated.',
};

export type RescueTextKey = keyof typeof fr;

export function rescueText(key: RescueTextKey): string {
  return (getLocale() === 'en' ? en : fr)[key];
}
