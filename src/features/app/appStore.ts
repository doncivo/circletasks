import { create } from 'zustand';
import type { Project, Space } from '../../domain/model';
import type { LocalDate, ProjectId, SpaceFilter } from '../../domain/types';

/** État de démarrage de la base locale. */
export type DbStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Diagnostic de l'échec de démarrage (0.2.1), affiché sous le message d'erreur et copiable.
 * - phase 'open' : ouverture de la base (étape fine, numéro de migration) ;
 * - phase 'start' : suite du démarrage, base déjà ouverte (étape = nom du module en cours).
 */
export interface DbFailure {
  readonly phase: 'open' | 'start';
  readonly step: string;
  readonly migration?: number | undefined;
  readonly errorName: string;
  readonly message: string;
  /** Mode de journal effectif de la base ouverte (PRAGMA journal_mode) ; null si illisible, absent si la base n'était pas ouverte. */
  readonly journalMode?: string | null;
  /**
   * I-06 (ADR 0007 avenant I-06 point 7) : nature de l'échec d'ouverture : base plus récente que l'app, migration, sauvegarde avant
   * migration, autre. Absent pour la suite du démarrage et le chien de garde.
   */
  readonly kind?: 'schema-newer' | 'migration' | 'backup' | 'other';
  /** Version de l'app (`appVersion.ts`) ; null si illisible. */
  readonly appVersion?: string | null;
  /** Dernière migration appliquée à la base au moment de l'échec ; null si `schema_migrations` n'a pas été lue. */
  readonly schemaVersion?: number | null;
  /** Dernière migration connue du code. */
  readonly appSchemaVersion?: number;
  /** Sauvegarde « Avant mise à jour » de ce démarrage (créée ou réutilisée) : nom seul ; null s'il n'y en a pas. */
  readonly updateBackup?: { readonly name: string } | null;
}

/**
 * Store global minimal de l'app (Zustand). Les features ajoutent leurs propres
 * stores ; celui-ci ne garde que l'état transverse.
 */
export interface AppState {
  readonly dbStatus: DbStatus;
  /** Message technique de la dernière erreur d'ouverture (écran de logs, jamais affiché tel quel). */
  readonly dbErrorDetail: string | null;
  /** La sauvegarde avant migration a échoué : migrations non appliquées, message dédié (app.dbBackupError). */
  readonly dbBackupFailed: boolean;
  /** Étape et erreur exactes du dernier échec de démarrage (null hors erreur). */
  readonly dbFailure: DbFailure | null;
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
   * Projets (ES-04), archivés compris, lus au démarrage et republiés à chaque modification (Réglages) : liste « Projet » des fenêtres
   * d'ajout, ligne Projet de la fiche, menu « Projet : tous ». Source unique, comme `spaces`.
   */
  readonly projects: readonly Project[];
  /**
   * Filtre par projet (QB-15, ES-04) : null = « Tous les projets ». Global comme le filtre d'espace, jamais mémorisé ; changer de filtre
   * d'espace le remet à null. Il ne s'applique que sous Pro ou Perso (`effectiveProjectFilter`).
   */
  readonly projectFilter: ProjectId | null;
  /**
   * Jour local courant de l'app (T-06) : posé au démarrage puis à chaque passage de minuit
   * par le déclencheur de report (`createDayRollover`) ; les écrans datés s'y rechargent.
   */
  readonly day: LocalDate | null;
  /** T-06 : le dernier report automatique a échoué (message dans Aujourd'hui). */
  readonly carryOverFailed: boolean;
  /** T-09 : la dernière création d'occurrences récurrentes a échoué (message propre, dans Aujourd'hui). */
  readonly recurrenceFailed: boolean;
  /** T-11 : fuseau IANA courant de l'appareil (détecté au démarrage et au retour au premier plan). */
  readonly timeZone: string | null;
  setTimeZone(timeZone: string): void;
  setDbStatus(status: DbStatus, options?: { readonly detail?: string; readonly backupFailed?: boolean; readonly failure?: DbFailure }): void;
  setDay(day: LocalDate): void;
  setCarryOverFailed(failed: boolean): void;
  setRecurrenceFailed(failed: boolean): void;
  setSpaceFilter(filter: SpaceFilter): void;
  setSpaces(spaces: readonly Space[]): void;
  setProjects(projects: readonly Project[]): void;
  setProjectFilter(projectId: ProjectId | null): void;
  /** Étape d'ouverture en cours (lue par le chien de garde du démarrage) ; null hors ouverture. */
  readonly dbProgress: { readonly step: string; readonly migration?: number | undefined } | null;
  setDbProgress(progress: AppState['dbProgress']): void;
}

export const useAppStore = create<AppState>()((set) => ({
  dbProgress: null,
  setDbProgress: (dbProgress) => set({ dbProgress }),
  dbStatus: 'idle',
  dbErrorDetail: null,
  dbBackupFailed: false,
  dbFailure: null,
  spaceFilter: 'all',
  spaces: [],
  projects: [],
  projectFilter: null,
  day: null,
  carryOverFailed: false,
  recurrenceFailed: false,
  timeZone: null,
  setTimeZone: (timeZone) => set({ timeZone }),
  setDbStatus: (dbStatus, options) => set({ dbStatus, dbErrorDetail: options?.detail ?? null, dbBackupFailed: options?.backupFailed ?? false, dbFailure: options?.failure ?? null }),
  setDay: (day) => set({ day }),
  setCarryOverFailed: (carryOverFailed) => set({ carryOverFailed }),
  setRecurrenceFailed: (recurrenceFailed) => set({ recurrenceFailed }),
  // Changer de filtre d'espace remet « Projet : tous » (QB-15) ; rechoisir le même filtre ne change rien.
  setSpaceFilter: (spaceFilter) => set((s) => (s.spaceFilter === spaceFilter ? s : { spaceFilter, projectFilter: null })),
  setSpaces: (spaces) => set({ spaces }),
  setProjects: (projects) => set({ projects }),
  setProjectFilter: (projectFilter) => set({ projectFilter }),
}));
