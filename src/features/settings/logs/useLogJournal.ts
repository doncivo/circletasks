import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { currentLogJournal, whenLogJournal } from '../../../platform/desktop/log';
import type { LogJournal, LogStatus } from '../../../platform/logs/types';
import { journalInstallError, startLogJournal } from '../../app/logJournalBoot';

/** Attente du journal avant de le déclarer indisponible (chargement à la demande au démarrage). */
export const LOG_JOURNAL_WAIT_MS = 5_000;

export interface LogJournalState {
  readonly journal: LogJournal | null;
  /** Code quand le journal n'est toujours pas installé après l'attente (`load-failed`, `not-installed`), sinon null. */
  readonly unavailable: string | null;
  /** Relance le chargement du journal (« Réessayer » de l'écran Logs). */
  retry(): void;
}

/**
 * Journal installé au démarrage (`startLogJournal`), dès qu'il existe. Jamais d'attente sans fin : au bout de 5 s sans journal, l'état
 * « indisponible » porte un code et `retry` relance le chargement (aucune impasse, règle d'Ali).
 */
export function useLogJournal(): LogJournalState {
  const [journal, setJournal] = useState<LogJournal | null>(currentLogJournal);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (journal) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      if (active) setUnavailable(journalInstallError() ?? 'not-installed');
    }, LOG_JOURNAL_WAIT_MS);
    void whenLogJournal().then((installed) => {
      if (!active) return;
      clearTimeout(timer);
      setUnavailable(null);
      setJournal(installed);
    });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [journal, attempt]);
  return {
    journal,
    unavailable: journal ? null : unavailable,
    retry: () => {
      setUnavailable(null);
      setAttempt((value) => value + 1);
      void startLogJournal('main');
    },
  };
}

const NO_FAILURE: LogStatus = { writeError: null, readError: null };
const noop = (): (() => void) => () => undefined;

/** État d'échec du journal (écriture, lecture), suivi en direct : message rouge de l'écran Logs et de la ligne « Logs » (critère 10). */
export function useLogStatus(journal: LogJournal | null): LogStatus {
  const subscribe = useMemo(() => (journal ? (listener: () => void) => journal.subscribe(listener) : noop), [journal]);
  return useSyncExternalStore(subscribe, () => (journal ? journal.status() : NO_FAILURE));
}
