/**
 * Revue du lot F (mineur) : le planificateur des sauvegardes est chargé à la demande au démarrage ; un échec de ce chargement est visible
 * dans la ligne « Sauvegarde automatique » (« Dernière sauvegarde échouée », code `load-failed`), jamais seulement journalisé.
 */
let loadFailed = false;

export function noteBackupSchedulerLoadFailed(): void {
  loadFailed = true;
}

export function backupSchedulerLoadFailed(): boolean {
  return loadFailed;
}
