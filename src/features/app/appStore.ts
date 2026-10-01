import { create } from 'zustand';
import type { SpaceFilter } from '../../domain/types';

/** État de démarrage de la base locale. */
export type DbStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Store global minimal de l'app (Zustand). Les features ajoutent leurs propres
 * stores ; celui-ci ne garde que l'état transverse.
 */
export interface AppState {
  readonly dbStatus: DbStatus;
  /** Message technique de la dernière erreur d'ouverture (écran de logs, jamais affiché tel quel). */
  readonly dbErrorDetail: string | null;
  /** Filtre Pro / Perso / Tout appliqué à tous les écrans (CLAUDE.md). */
  readonly spaceFilter: SpaceFilter;
  setDbStatus(status: DbStatus, errorDetail?: string): void;
  setSpaceFilter(filter: SpaceFilter): void;
}

export const useAppStore = create<AppState>()((set) => ({
  dbStatus: 'idle',
  dbErrorDetail: null,
  spaceFilter: 'all',
  setDbStatus: (dbStatus, errorDetail) => set({ dbStatus, dbErrorDetail: errorDetail ?? null }),
  setSpaceFilter: (spaceFilter) => set({ spaceFilter }),
}));
