/** Feuille des sauvegardes et reprise de la synchro (P-04-iOS) : textes chargés avec les écrans de Réglages, hors du bundle de départ. */
export const backupRestoreFr = {
  folderIos: 'Dossier de l’app (non visible dans Fichiers)',
  errorSyncBusy: 'Une synchronisation est en cours, réessayez. Rien n’a été modifié.',
  errorBusy: 'Une mise à jour des rappels est en cours, réessayez dans un instant. Rien n’a été modifié.',
  errorDbOpen: 'La base n’a pas pu être fermée pour la restauration. Rien n’a été modifié : réessayez.',
  retry: 'Réessayer',
  seeSync: 'Voir la synchronisation',
  resumeSync: 'Reprendre la synchronisation',
  resumeSyncTitle: 'Reprendre la synchronisation ?',
  resumeSyncText: 'Les données synchronisées pourront remplacer la version restaurée sur cet appareil.',
  recoveryConflict: 'Des fichiers empêchent la remise en place de vos données. Ils peuvent être mis de côté dans le dossier des sauvegardes : rien n’est supprimé.',
  recoverySetAside: 'Mettre les fichiers en conflit de côté',
  recoverySetAsideBusy: 'Mise de côté en cours…',
  recoveryStillFailed: 'La récupération reste impossible : fermez puis rouvrez CircleTasks. Si le message revient, copiez le détail.',
  recoveryNoDataDir: 'Le dossier des données de l’app est introuvable : fermez puis rouvrez CircleTasks. Rien n’a été modifié.',
  recoverySqlPlugin: 'Le module de base de données n’a pas démarré : fermez puis rouvrez CircleTasks. Vos données ne sont pas touchées.',
} as const;
