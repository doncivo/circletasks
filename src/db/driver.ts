/**
 * Contrat d'accès SQLite commun à toutes les implémentations (ADR 0002).
 *
 * - Paramètres positionnels `?` uniquement (compris par sqlx et par SQLite Wasm).
 * - Valeurs liées limitées à texte, nombre et NULL : les booléens sont stockés en 0/1,
 *   les objets en JSON texte, les dates en texte ISO. Pas de BLOB (non transportable
 *   par l'IPC JSON du plugin Tauri SQL).
 * - Seuls src/db/repositories et src/db/migrator utilisent ce contrat ; les features
 *   n'écrivent jamais de SQL.
 */

export type SqlValue = string | number | null;

export type SqlParams = readonly SqlValue[];

/** Ligne renvoyée par un SELECT : colonnes nommées. */
export type SqlRow = Record<string, SqlValue>;

export interface ExecuteResult {
  readonly rowsAffected: number;
  /** ROWID de la dernière insertion ; sans intérêt pour les tables à clé UUID. */
  readonly lastInsertId: number | null;
}

/** Opérations disponibles hors transaction et à l'intérieur d'une transaction. */
export interface SqlExecutor {
  execute(sql: string, params?: SqlParams): Promise<ExecuteResult>;
  select<T extends SqlRow = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>;
}

export type SqlDriverKind = 'tauri-sqlite' | 'sqlite-wasm';

export interface SqlDriver extends SqlExecutor {
  readonly kind: SqlDriverKind;
  /**
   * Exécute `fn` dans une transaction (BEGIN IMMEDIATE … COMMIT, ROLLBACK si `fn` rejette).
   * Toutes les requêtes de `fn` passent par `tx`. Les appels directs au driver émis
   * pendant la transaction attendent leur tour ; au-delà du délai configuré (10 s par
   * défaut) ils échouent en DbError 'transaction-wait-timeout'. Un appel réentrant depuis
   * `fn` (ou une transaction imbriquée) finit donc en erreur au lieu de bloquer.
   * Un `tx` utilisé après la fin de sa transaction échoue en DbError 'closed'.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbErrorCode = 'constraint' | 'busy' | 'syntax' | 'transaction-wait-timeout' | 'transaction-lost' | 'closed' | 'unknown';

/** Erreur normalisée renvoyée par tous les drivers (message brut conservé dans `cause`). */
export class DbError extends Error {
  override readonly name = 'DbError';
  readonly code: DbErrorCode;
  readonly sql: string | undefined;

  constructor(code: DbErrorCode, message: string, options?: { sql?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.sql = options?.sql;
  }
}

/** Classe une erreur SQLite brute (message sqlx ou SQLite Wasm) dans un code stable. */
export function classifySqliteMessage(message: string): DbErrorCode {
  if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) return 'constraint';
  if (/database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) return 'busy';
  if (/syntax error|no such (table|column)|SQLITE_ERROR\b/i.test(message)) return 'syntax';
  return 'unknown';
}

export function toDbError(error: unknown, sql?: string): DbError {
  if (error instanceof DbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DbError(classifySqliteMessage(message), message, {
    ...(sql === undefined ? {} : { sql }),
    cause: error,
  });
}
