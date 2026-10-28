import { getLocale } from './index';

/**
 * Textes propres à la refonte de l'écran Synchronisation (UI-REFONTE-04, Synchro-v4.html) : chargés avec l'écran, hors du bundle de départ.
 * Les textes d'état, d'appareils, de conflits et de réinitialisation déjà partagés avec le bandeau et la ligne de Réglages restent dans
 * `fr.syncEngine.ts`, `fr.syncConflicts.ts` et `fr.syncReset.ts`.
 */
const fr = {
  back: 'Réglages',
  conflictsHelp: 'Deux appareils ont modifié la même chose. La version la plus récente est appliquée.',
  applied: 'Appliquée · {side}',
  resetBodyBefore: 'Une nouvelle clé est créée. ',
  resetBodyStrong: 'Vos autres appareils devront être associés de nouveau',
  resetBodyAfter: ' (QR code ou clé de secours) et l’historique partagé repart à zéro. Vos tâches ne sont pas supprimées.',
} as const;
const en: Record<keyof typeof fr, string> = {
  back: 'Settings',
  conflictsHelp: 'Two devices changed the same thing. The most recent version is applied.',
  applied: 'Applied · {side}',
  resetBodyBefore: 'A new key is created. ',
  resetBodyStrong: 'Your other devices will have to be paired again',
  resetBodyAfter: ' (QR code or recovery key) and the shared history starts over. Your tasks are not deleted.',
};

export function tSyncRefonte(key: keyof typeof fr, params: Record<string, string> = {}): string {
  let text: string = (getLocale() === 'en' ? en : fr)[key];
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, value);
  return text;
}
