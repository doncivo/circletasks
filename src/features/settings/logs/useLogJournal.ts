import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { currentLogJournal, whenLogJournal } from '../../../platform/desktop/log';
import type { LogJournal, LogStatus } from '../../../platform/logs/types';

/** Journal installé au démarrage (`startLogJournal`), dès qu'il existe. */
export function useLogJournal(): LogJournal | null {
  const [journal, setJournal] = useState<LogJournal | null>(currentLogJournal);
  useEffect(() => {
    if (journal) return undefined;
    let active = true;
    void whenLogJournal().then((installed) => {
      if (active) setJournal(installed);
    });
    return () => {
      active = false;
    };
  }, [journal]);
  return journal;
}

const NO_FAILURE: LogStatus = { writeError: null, readError: null };
const noop = (): (() => void) => () => undefined;

/** État d'échec du journal (écriture, lecture), suivi en direct : message rouge de l'écran Logs et de la ligne « Logs » (critère 10). */
export function useLogStatus(journal: LogJournal | null): LogStatus {
  const subscribe = useMemo(() => (journal ? (listener: () => void) => journal.subscribe(listener) : noop), [journal]);
  return useSyncExternalStore(subscribe, () => (journal ? journal.status() : NO_FAILURE));
}
