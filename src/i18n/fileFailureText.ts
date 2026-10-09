import { getLocale } from './index';

/**
 * Échecs d'enregistrement qu'un nouvel essai ne peut pas résoudre (revue du lot F) : texte et action utile à la place de « Réessayer ».
 * Catalogue à part (chargé avec les écrans qui enregistrent, hors du bundle de départ) ; mêmes clés en anglais (`fileFailureText.test.ts`).
 */
export const fileFailureFr = {
  unsafeFolder: 'Le dossier temporaire de l’app est anormal : fermez puis rouvrez CircleTasks, il est remis en ordre au lancement.',
  badName: 'Le nom du fichier a été refusé, rien n’a été enregistré : exportez les logs (Réglages › À propos › Logs) pour le signaler.',
} as const;

export const fileFailureEn: { readonly [K in keyof typeof fileFailureFr]: string } = {
  unsafeFolder: 'The app temporary folder is abnormal: close and reopen CircleTasks, it is fixed at launch.',
  badName: 'The file name was refused, nothing was saved: export the logs (Settings › About › Logs) to report it.',
};

export function tFileFailure(key: keyof typeof fileFailureFr): string {
  return (getLocale() === 'en' ? fileFailureEn : fileFailureFr)[key];
}
