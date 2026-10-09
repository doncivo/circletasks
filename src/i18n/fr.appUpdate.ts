/**
 * Mise à jour de l'app (I-06, ADR 0007 avenant I-06 points 4 et 7) : écran d'échec du démarrage après une mise à jour (base plus récente
 * que l'app, migration en échec). Les textes de la restauration (action chargée à la demande) sont dans `fr.appUpdateRestore.ts`. Aucun nom de
 * tâche ni chemin.
 */
export const appUpdateFr = {
  /** Base plus récente que l'app (iPhone : la mise à jour passe par SideStore). */
  schemaNewer: 'Cette version de CircleTasks est plus ancienne que vos données. Installez la dernière version depuis SideStore. Vos données ne sont pas modifiées.',
  /** Même cas sur le PC : l'app ne s'ouvre pas, Réglages n'est pas joignable ; l'installeur vient de la page des versions. */
  schemaNewerPc: 'Cette version de CircleTasks est plus ancienne que vos données. Installez la dernière version pour PC depuis la page des versions de CircleTasks (circletasks-releases). Vos données ne sont pas modifiées.',
  /** Migration en échec : consigne affichée sous le message d'échec. */
  migrationIntact: 'Vos données sont intactes. Ne supprimez pas CircleTasks. Envoyez le détail pour obtenir un correctif.',
  appVersionLine: 'Version de l’app : {version}',
  schemaLine: 'Schéma de la base : {database} (dernier connu de l’app : {app})',
  backupLine: 'Sauvegarde d’avant la mise à jour : {name}',
} as const;
