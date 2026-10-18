/**
 * Y-FIX-02 (ADR 0011 §30) : causes nommées de l’avertissement « état de cet appareil non publié » (`publish-blocked`), section
 * AVERTISSEMENTS de Réglages › Synchronisation › Détails. À part du catalogue principal (bundle de départ) : chargées avec l’écran Détails,
 * jamais au démarrage.
 */
export const syncPublishCauseFr = {
  'first-publication-state-refused': 'Première publication interrompue : l’état de cet appareil n’a pas pu être écrit. Nouvel essai à chaque synchro.',
  'unexplained-files': 'Fichier inconnu dans le dossier de cet appareil : son état n’est pas publié tant qu’il reste.',
} as const;
