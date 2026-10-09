/**
 * Sauvegardes locales de la base (P-04) : contrat commun à l'app installée (commandes Rust de `src-tauri/src/backup.rs`), au navigateur de
 * développement et aux tests (service en mémoire). Seul `src/platform/backup` appelle ces commandes ; les features reçoivent un
 * `BackupService` par le conteneur.
 */

/** `daily` : une par jour (14 gardées) ; `pre-migration` : avant une mise à jour du schéma (5) ; `pre-restore` : copie de sécurité d'une restauration (3). */
export type BackupKind = 'daily' | 'pre-migration' | 'pre-restore';

export interface BackupVersion {
  /** Nom du fichier dans le dossier des sauvegardes : seul identifiant transmis à Rust (jamais un chemin). */
  readonly name: string;
  readonly kind: BackupKind;
  /** Jour `AAAAMMJJ` (quotidienne) ou horodatage UTC `AAAAMMJJTHHMMSSZ`. */
  readonly stamp: string;
  readonly size: number;
  /** Heure réelle de la sauvegarde (ms depuis l'époque Unix). */
  readonly modifiedMs: number;
  /** Tâches non supprimées de la version ; null si elle n'est pas lisible. */
  readonly tasks: number | null;
  readonly schemaVersion: number | null;
}

export interface BackupListing {
  /** Dossier des sauvegardes (PC) ; null quand la plateforme n'en a pas (navigateur de développement). */
  readonly directory: string | null;
  readonly versions: readonly BackupVersion[];
}

/**
 * `sync-busy` / `busy` (P-04-iOS critère 6) : un cycle de synchro ou une mise à jour des rappels n'a pas fini dans les 10 s de la mise au
 * calme ; rien n'est modifié, l'utilisateur peut réessayer. `db-open` : la connexion à la base n'était pas fermée (Rust refuse l'échange).
 */
export type BackupFailureReason = 'corrupt' | 'newer-schema' | 'not-found' | 'io' | 'rollback-failed' | 'restore-pending' | 'restore-unconfirmed' | 'unavailable' | 'sync-busy' | 'busy' | 'db-open';

/** Échec d'une opération de sauvegarde. Pour `restore`, `databaseClosed` indique qu'un redémarrage est nécessaire pour rouvrir la base. */
export class BackupError extends Error {
  override readonly name = 'BackupError';
  readonly reason: BackupFailureReason;
  readonly databaseClosed: boolean;

  constructor(reason: BackupFailureReason, options: { cause?: unknown; databaseClosed?: boolean } = {}) {
    super(`sauvegarde : ${reason}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.databaseClosed = options.databaseClosed ?? false;
  }
}

/** Raison et état de la base d'une erreur de sauvegarde (reconnue par sa forme : les faux des tests de bout en bout ont leur propre classe). */
export function backupFailureOf(error: unknown): { readonly reason: BackupFailureReason; readonly databaseClosed: boolean } {
  const candidate = typeof error === 'object' && error !== null ? (error as { reason?: unknown; databaseClosed?: unknown }) : {};
  const reason = typeof candidate.reason === 'string' ? (candidate.reason as BackupFailureReason) : 'io';
  return { reason, databaseClosed: candidate.databaseClosed === true };
}

export interface DailyBackupRequest {
  /** Jour local `AAAAMMJJ` (horloge injectée). */
  readonly day: string;
  /** Vrai pour « Sauvegarder maintenant » : remplace la version du jour. */
  readonly replace: boolean;
}

export interface RestoreRequest {
  readonly name: string;
  /** Horodatage UTC `AAAAMMJJTHHMMSSZ` de la copie de sécurité. */
  readonly stamp: string;
}

/** Marqueur de restauration de la synchro (ADR 0010 règle 2) écrit par Rust après l'échange (P-04-iOS critère 12). */
export interface RestoreResult {
  readonly marker: 'written' | 'not-configured' | 'failed';
  readonly markerCode: string | null;
}

export interface RestoreHooks {
  /**
   * Appelé après la vérification (base encore ouverte) et AVANT le point de contrôle et la fermeture : mise au calme et voile. Un rejet
   * arrête la restauration sans rien modifier (`databaseClosed` faux).
   */
  readonly prepare?: () => Promise<void>;
}

export interface BackupService {
  /** Cette plateforme sauvegarde-t-elle ? Faux sur iPhone tant que les commandes ne lui sont pas ouvertes : la section est alors masquée. */
  available(): boolean;
  list(): Promise<BackupListing>;
  /** Crée la sauvegarde du jour ; `created: false` si elle existait déjà (sans `replace`). */
  createDaily(request: DailyBackupRequest): Promise<{ readonly created: boolean }>;
  /**
   * Restaure une version : la vérifie, ferme la base, remplace le fichier (copie de sécurité faite avant). Résout quand les fichiers sont
   * en place ; l'app doit alors redémarrer (`restart`). Rejette avec `BackupError` ; rien n'est modifié si `databaseClosed` est faux.
   */
  /** Marqueur écrit par Rust ; `undefined` pour un service sans marqueur (faux, navigateur). */
  restore(request: RestoreRequest, hooks?: RestoreHooks): Promise<RestoreResult | undefined>;
  /** Relance l'app (PC) ou recharge la WebView (iPhone) : rouvre la base, restaurée ou non. */
  restart(): Promise<void>;
  /** Affiche le dossier des sauvegardes (PC) ; absent ailleurs. */
  reveal?(): Promise<void>;
}
