import type { Migration } from '../migrator';

/**
 * Registre ordonné des migrations de l'app. Ajouter chaque nouveau fichier
 * `NNNN_titre.ts` ici, à la fin, sans jamais modifier une entrée publiée.
 * Les tables métier (PRD section 6) arrivent avec l'agent data-model (ordre 1).
 */
export const migrations: readonly Migration[] = [];
