import type { LogEntry, LogTransport } from './types';

export interface MemoryLogTransport extends LogTransport {
  /** Contenu « du fichier » (survit à un redémarrage simulé : le même transport est repris par un nouveau journal). */
  readonly stored: LogEntry[];
  /** Prochaines écritures refusées avec ce code (`disk-full`, `unsafe-file`…), jusqu'à `failAppend(null)`. */
  failAppend(code: string | null): void;
  /** Prochaines lectures refusées avec ce code (`unreadable`…), jusqu'à `failRead(null)`. */
  failRead(code: string | null): void;
  readonly appendCalls: number;
}

/**
 * Faux du transport Rust (tests et navigateur de développement) : garde les entrées en mémoire, comme le ferait le fichier ; sait refuser
 * l'écriture ou la lecture à la demande. Le crochet `globalThis.__ctLogs` (développement seulement) permet aux e2e d'en poser un rempli.
 */
export function createMemoryLogTransport(initial: readonly LogEntry[] = []): MemoryLogTransport {
  const stored: LogEntry[] = [...initial];
  let appendFailure: string | null = null;
  let readFailure: string | null = null;
  let appendCalls = 0;
  return {
    stored,
    get appendCalls() {
      return appendCalls;
    },
    failAppend: (code) => {
      appendFailure = code;
    },
    failRead: (code) => {
      readFailure = code;
    },
    append(entries) {
      appendCalls += 1;
      if (appendFailure) return Promise.reject({ code: appendFailure });
      stored.push(...entries);
      return Promise.resolve({ writeError: null });
    },
    read(max) {
      if (readFailure) return Promise.reject({ code: readFailure });
      return Promise.resolve({ entries: stored.slice(-max), writeError: null });
    },
    clear() {
      stored.splice(0, stored.length, { at: new Date().toISOString(), scope: 'logs', code: 'logs-cleared', detail: '' });
      return Promise.resolve();
    },
  };
}
