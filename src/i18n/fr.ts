/**
 * Textes de l'interface, en français : source de vérité (ADR 0003).
 * - Clés regroupées par écran / module, en camelCase ;
 * - paramètres entre accolades : « {count} tâches » ;
 * - toute nouvelle clé s'ajoute ici d'abord, puis dans en.ts (le typage l'impose).
 */
export const fr = {
  app: {
    name: 'CircleTasks',
    loading: 'Chargement…',
    dbError: 'Impossible d’ouvrir la base de données.',
    version: 'Version {version}',
  },
} as const;
