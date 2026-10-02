import { create } from 'zustand';
import type { Space } from '../../domain/model';
import type { LocalDate, SpaceFilter } from '../../domain/types';

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
  /**
   * Espaces (ES-01), lus une fois via `SpaceRepository.listAll()` juste après le
   * démarrage (App.tsx) : disponibles avant le premier rendu des écrans, pour que
   * les features ne lisent jamais `src/db/seed` (uniquement réservé aux migrations
   * et aux tests).
   */
  readonly spaces: readonly Space[];
  /**
   * Jour local courant de l'app (T-06) : posé au démarrage puis à chaque passage de minuit
   * par le déclencheur de report (`createDayRollover`) ; les écrans datés s'y rechargent.
   */
  readonly day: LocalDate | null;
  /** T-06 : le dernier report automatique a échoué (message dans Aujourd'hui). */
  readonly carryOverFailed: boolean;
  setDbStatus(status: DbStatus, errorDetail?: string): void;
  setDay(day: LocalDate): void;
  setCarryOverFailed(failed: boolean): void;
  setSpaceFilter(filter: SpaceFilter): void;
  setSpaces(spaces: readonly Space[]): void;
}

export const useAppStore = create<AppState>()((set) => ({
  dbStatus: 'idle',
  dbErrorDetail: null,
  spaceFilter: 'all',
  spaces: [],
  day: null,
  carryOverFailed: false,
  setDbStatus: (dbStatus, errorDetail) => set({ dbStatus, dbErrorDetail: errorDetail ?? null }),
  setDay: (day) => set({ day }),
  setCarryOverFailed: (carryOverFailed) => set({ carryOverFailed }),
  setSpaceFilter: (spaceFilter) => set({ spaceFilter }),
  setSpaces: (spaces) => set({ spaces }),
}));
