/**
 * Fenêtre de choix après une restauration (Y-02, ADR 0011 section 9) et avertissement de la feuille des sauvegardes : textes à part du
 * catalogue principal, chargés avec la fenêtre (`RestoreChoiceDialog`, bloc à la demande) et les écrans de Réglages, jamais au départ
 * (Y-FIX-04, décision d'Ali du 2026-10-18 : tout écran qui ne s'affiche pas au démarrage est chargé à la demande).
 */
export const syncRestoreFr = {
  title: 'Restauration : que faire de la synchronisation ?',
  body: 'Les modifications que cet appareil avait déjà reçues seront remplacées sur tous vos appareils',
  applyEverywhere: 'Appliquer cette version sur tous mes appareils',
  keepSynced: 'Garder les données synchronisées',
  bodyOnlyApply:
    'Les modifications que cet appareil avait déjà reçues seront remplacées sur tous vos appareils. Une suppression plus récente que cette sauvegarde a déjà été effacée définitivement de vos appareils : seule la première option est possible.',
  later: 'Plus tard',
  resetInProgress: 'Une réinitialisation de la synchronisation est en cours : cette version ne pourra être appliquée partout qu’à sa fin.',
  resetFinish:
    'Une réinitialisation de la synchronisation est en cours et une suppression plus récente que cette sauvegarde a déjà été effacée définitivement : terminez-la sur l’appareil qui réinitialise.',
  failed: 'Le choix n’a pas pu être appliqué ({reason}). Rien n’a été changé : vous pouvez réessayer.',
  failedReset: 'Le choix n’a pas été appliqué : une réinitialisation de la synchronisation est en cours. Rien n’a été changé.',
  scanFailed: 'Le dossier de synchro n’a pas pu être vérifié : « Appliquer cette version sur tous mes appareils » sera proposé quand il sera joignable.',
  provisional: 'La restauration n’a pas pu être confirmée pour l’instant : « Appliquer cette version sur tous mes appareils » n’est pas proposé. CircleTasks revérifie au prochain démarrage : fermez puis rouvrez l’app.',
  provisionalNoOption: 'La restauration n’a pas pu être confirmée pour l’instant. CircleTasks revérifie au prochain démarrage : fermez puis rouvrez l’app.',
  scanFailedNoOption: 'Le dossier de synchro n’a pas pu être vérifié : réessayez quand il sera joignable.',
  backupWarning: 'Cet appareil est associé : le choix vous sera demandé à la prochaine synchro',
} as const;
