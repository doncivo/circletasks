import { codeAndDetailOf, normalizeScope } from './sanitize';
import { LOG_BATCH_SIZE, LOG_BUFFER_SIZE, LOG_FLUSH_MS, LOG_READ_MAX, type LogEntry, type LogJournal, type LogStatus, type LogTransport } from './types';

export interface LogJournalEnv {
  readonly now?: () => Date;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
  /** Vidage au passage en arrière-plan (`visibilitychange` -> hidden) et à `pagehide`. */
  readonly document?: Pick<Document, 'visibilityState' | 'addEventListener'> | null;
  readonly window?: Pick<Window, 'addEventListener'> | null;
}

function codeOf(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(code) ? code : 'io';
}

const sameEntry = (a: LogEntry, b: LogEntry): boolean => a.scope === b.scope && a.code === b.code && a.detail === b.detail;

/**
 * Journal de la session (ADR 0014 §3) : tampon circulaire de 500 entrées (lisible même si l'écriture échoue), vidé vers le transport par
 * lots de 100 toutes les 2 s, au passage en arrière-plan et à `pagehide` ; un lot refusé reste au tampon (nouvel essai au vidage suivant).
 * Entrées identiques consécutives fusionnées (`n`). Sans transport (fenêtres secondaires du PC), la session seule est gardée, sans état
 * d'échec.
 */
export function createLogJournal(transport: LogTransport | null, env: LogJournalEnv = {}): LogJournal & { dispose(): void } {
  const now = env.now ?? (() => new Date());
  /** Entrées de la session (lecture de secours), et celles qui attendent d'être écrites. */
  let session: LogEntry[] = [];
  let pending: LogEntry[] = [];
  let status: LogStatus = { writeError: null, readError: null };
  const listeners = new Set<() => void>();
  /** Vidages enchaînés : un vidage demandé pendant un autre part après lui (une entrée notée entre-temps n'est jamais oubliée). */
  let queue: Promise<void> = Promise.resolve();

  const setStatus = (next: Partial<LogStatus>): void => {
    const merged = { ...status, ...next };
    if (merged.writeError === status.writeError && merged.readError === status.readError) return;
    status = merged;
    for (const listener of [...listeners]) listener();
  };

  const push = (list: LogEntry[], entry: LogEntry): LogEntry[] => {
    const last = list.at(-1);
    if (last && sameEntry(last, entry)) {
      list[list.length - 1] = { ...last, at: entry.at, n: (last.n ?? 1) + 1 };
      return list;
    }
    list.push(entry);
    return list.length > LOG_BUFFER_SIZE ? list.slice(list.length - LOG_BUFFER_SIZE) : list;
  };

  async function flushOnce(): Promise<void> {
    if (!transport) return;
    while (pending.length > 0) {
      const batch = pending.slice(0, LOG_BATCH_SIZE);
      try {
        const result = await transport.append(batch);
        pending = pending.slice(batch.length);
        setStatus({ writeError: result.writeError });
      } catch (error) {
        setStatus({ writeError: codeOf(error) });
        return;
      }
    }
  }

  const flush = (): Promise<void> => {
    queue = queue.then(flushOnce);
    return queue;
  };

  const setTimer = env.setInterval ?? ((handler, ms) => globalThis.setInterval(handler, ms));
  const clearTimer = env.clearInterval ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  const timer = transport ? setTimer(() => void flush(), LOG_FLUSH_MS) : null;
  const doc = env.document === undefined ? (typeof document === 'undefined' ? null : document) : env.document;
  const win = env.window === undefined ? (typeof window === 'undefined' ? null : window) : env.window;
  if (transport) {
    doc?.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') void flush();
    });
    win?.addEventListener('pagehide', () => void flush());
  }

  return {
    persistent: transport !== null,
    record(scope, error) {
      const { code, detail } = codeAndDetailOf(error);
      const entry: LogEntry = { at: now().toISOString(), scope: normalizeScope(scope), code, detail };
      session = push(session, entry);
      if (transport) pending = push(pending, entry);
    },
    flush,
    async read(max = LOG_READ_MAX) {
      const limit = Math.max(1, Math.min(max, LOG_READ_MAX));
      if (!transport) return session.slice(-limit);
      await flush();
      try {
        const result = await transport.read(limit);
        setStatus({ readError: null, writeError: result.writeError ?? status.writeError });
        // Ce qui n'a pas pu être écrit reste lisible : ajouté après le contenu du fichier.
        return [...result.entries, ...pending].slice(-limit);
      } catch (error) {
        setStatus({ readError: codeOf(error) });
        return session.slice(-limit);
      }
    },
    async clear() {
      if (transport) {
        try {
          await transport.clear();
        } catch (error) {
          setStatus({ writeError: codeOf(error) });
          throw error;
        }
      }
      session = [];
      pending = [];
      setStatus({ writeError: null, readError: null });
    },
    status: () => status,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      listeners.clear();
    },
  };
}
