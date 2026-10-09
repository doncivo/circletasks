/**
 * Journal technique persistant (I-04, ADR 0014 §3) : contrat commun au transport Rust (`log_append`, `log_read`, `log_clear`, nommés par
 * `tauriLogs.ts` seulement), au faux en mémoire et au tampon de la session.
 *
 * Règle écrite pour les appelants de `logFailure` : ne passer que des codes, compteurs et identifiants techniques — jamais un titre, une
 * note, un nom de projet, une valeur de champ, un chemin, une clé ou un jeton. L'assainissement n'est qu'une seconde barrière.
 */

export interface LogEntry {
  /** Instant ISO UTC. */
  readonly at: string;
  readonly scope: string;
  readonly code: string;
  readonly detail: string;
  /** Entrées identiques consécutives fusionnées (2 ou plus), ou compteur d'une entrée de Rust (temporaires purgés). */
  readonly n?: number;
}

export type LogCategory = 'sync' | 'notifications' | 'errors';

/** Catégorie d'affichage : `sync*` -> Synchro ; `notifications`, `reminders*` -> Notifications ; le reste -> Erreurs. */
export function categoryOf(scope: string): LogCategory {
  if (scope.startsWith('sync')) return 'sync';
  if (scope === 'notifications' || scope.startsWith('reminders')) return 'notifications';
  return 'errors';
}

/** Transport persistant (Rust dans l'app installée, mémoire ailleurs). Rejette `{ code }`. */
export interface LogTransport {
  append(entries: readonly LogEntry[]): Promise<{ readonly writeError: string | null }>;
  read(max: number): Promise<{ readonly entries: readonly LogEntry[]; readonly writeError: string | null }>;
  clear(): Promise<void>;
}

export interface LogStatus {
  /** Dernier échec d'écriture (code), effacé à la prochaine écriture réussie. */
  readonly writeError: string | null;
  /** Dernier échec de lecture (code), effacé à la prochaine lecture réussie. */
  readonly readError: string | null;
}

export interface LogJournal {
  /** Note un échec (scope, erreur) : code et détail extraits et assainis, entrée gardée au tampon puis écrite. */
  record(scope: string, error: unknown): void;
  /** Écrit le tampon (lots de 100) ; ne rejette jamais (un lot refusé reste au tampon). */
  flush(): Promise<void>;
  /** Les `max` dernières entrées (500 au plus), plus récente en dernier ; en cas d'échec de lecture, celles de la session. */
  read(max?: number): Promise<readonly LogEntry[]>;
  /** Efface le journal (après confirmation de l'écran). Rejette `{ code }` en cas d'échec. */
  clear(): Promise<void>;
  status(): LogStatus;
  subscribe(listener: () => void): () => void;
  /** Le journal écrit-il dans un fichier (fenêtre principale de l'app installée, ou faux) ? */
  readonly persistent: boolean;
}

/** Entrées gardées au tampon (session et attente d'écriture). */
export const LOG_BUFFER_SIZE = 500;
/** Entrées par appel de `log_append`. */
export const LOG_BATCH_SIZE = 100;
/** Période du vidage du tampon. */
export const LOG_FLUSH_MS = 2_000;
/** Entrées lues au plus. */
export const LOG_READ_MAX = 500;
