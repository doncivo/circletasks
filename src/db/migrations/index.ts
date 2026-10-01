import type { Migration } from '../migrator';
import { migration0001CoreTables } from './0001_core_tables';

/**
 * Registre ordonné des migrations de l'app. Ajouter chaque nouveau fichier
 * `NNNN_titre.ts` ici, à la fin, sans jamais modifier une entrée publiée.
 */
export const migrations: readonly Migration[] = [migration0001CoreTables];
