import {
  DbError,
  toDbError,
  type ExecuteResult,
  type SqlDriver,
  type SqlDriverKind,
  type SqlExecutor,
  type SqlParams,
  type SqlRow,
} from './driver';

/**
 * Connexion brute fournie par une implémentation (plugin Tauri SQL, SQLite Wasm…).
 * Elle n'a pas à gérer l'ordre des appels ni les transactions.
 */
export interface RawConnection {
  execute(sql: string, params: SqlParams): Promise<ExecuteResult>;
  select(sql: string, params: SqlParams): Promise<SqlRow[]>;
  close(): Promise<void>;
}

/** Délai d'attente par défaut d'un appel mis en file pendant une transaction. */
export const DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS = 10_000;

export interface SerializedDriverOptions {
  /**
   * Durée maximale (ms) pendant laquelle un appel émis alors qu'une transaction
   * s'exécute peut attendre son tour. Au-delà : DbError 'transaction-wait-timeout'.
   */
  readonly transactionWaitTimeoutMs?: number;
}

/**
 * Enveloppe commune à tous les drivers :
 * - sérialise les appels (une seule requête à la fois) : indispensable avec le plugin
 *   Tauri SQL, dont le pool sqlx ne garantit pas qu'un BEGIN et le COMMIT suivant
 *   passent par la même connexion si des requêtes s'intercalent (ADR 0002) ;
 * - implémente `transaction` par BEGIN IMMEDIATE / COMMIT / ROLLBACK ;
 * - les appels émis pendant une transaction (lectures de l'UI, autres stores) attendent
 *   leur tour ; s'ils attendent plus de `transactionWaitTimeoutMs`, ils sont rejetés.
 *   Cas typique : appel réentrant au driver depuis la transaction, qui sinon
 *   bloquerait la file pour toujours ;
 * - refuse l'usage d'un handle `tx` après la fin de sa transaction ;
 * - normalise les erreurs en `DbError`.
 */
export function createSerializedDriver(
  kind: SqlDriverKind,
  raw: RawConnection,
  options: SerializedDriverOptions = {},
): SqlDriver {
  const waitTimeoutMs = options.transactionWaitTimeoutMs ?? DEFAULT_TRANSACTION_WAIT_TIMEOUT_MS;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  /** Vrai pendant l'exécution d'une transaction. */
  let inTransaction = false;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new DbError('closed', 'Base fermée'));
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let abandoned = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const run = async (): Promise<void> => {
        if (abandoned) return;
        started = true;
        if (timer !== undefined) clearTimeout(timer);
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        }
      };
      queue = queue.then(run, run);

      if (inTransaction) {
        timer = setTimeout(() => {
          if (started) return;
          abandoned = true;
          reject(
            new DbError(
              'transaction-wait-timeout',
              `Appel en attente depuis plus de ${String(waitTimeoutMs)} ms derrière une transaction. ` +
                'Cause probable : appel réentrant au driver (ou transaction imbriquée) depuis la ' +
                'fonction de transaction ; utiliser le paramètre tx. Sinon, transaction trop longue.',
            ),
          );
        }, waitTimeoutMs);
      }
    });
  };

  const rawExecute = async (sql: string, params: SqlParams = []): Promise<ExecuteResult> => {
    try {
      return await raw.execute(sql, params);
    } catch (error) {
      throw toDbError(error, sql);
    }
  };

  const rawSelect = async <T extends SqlRow>(sql: string, params: SqlParams = []): Promise<T[]> => {
    try {
      return (await raw.select(sql, params)) as T[];
    } catch (error) {
      throw toDbError(error, sql);
    }
  };

  return {
    kind,
    execute: (sql, params) => enqueue(() => rawExecute(sql, params)),
    select: <T extends SqlRow = SqlRow>(sql: string, params?: SqlParams) =>
      enqueue(() => rawSelect<T>(sql, params)),
    transaction: <T>(fn: (tx: SqlExecutor) => Promise<T>) =>
      enqueue(async () => {
        let active = true;
        const guard = (): void => {
          if (!active) throw new DbError('closed', 'Transaction terminée');
        };
        const tx: SqlExecutor = {
          execute: async (sql, params) => {
            guard();
            return rawExecute(sql, params);
          },
          select: async <R extends SqlRow = SqlRow>(sql: string, params?: SqlParams) => {
            guard();
            return rawSelect<R>(sql, params);
          },
        };
        await rawExecute('BEGIN IMMEDIATE');
        inTransaction = true;
        try {
          const result = await fn(tx);
          try {
            await rawExecute('COMMIT');
          } catch (error) {
            // Connexion remplacée en cours de transaction (ping en échec côté sqlx) : les écritures ont été validées une à une sur la
            // nouvelle connexion, le COMMIT n'a plus de transaction. Échec visible de la transaction, jamais rattrapé en silence.
            if (/no transaction is active/i.test(error instanceof Error ? error.message : String(error))) {
              throw new DbError('transaction-lost', 'Transaction perdue : connexion remplacée avant le COMMIT', { cause: error });
            }
            throw error;
          }
          return result;
        } catch (error) {
          await rawExecute('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          active = false;
          inTransaction = false;
        }
      }),
    close: () => {
      const done = enqueue(() => raw.close());
      closed = true;
      return done;
    },
  };
}
