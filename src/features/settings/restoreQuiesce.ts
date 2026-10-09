import type { AppContainer } from '../app/container';
import { quietWorkSettled, setRestoreQuiet } from '../../platform/quiet';
import { getNotificationRunner } from '../reminders/notificationRunner';
import { pauseSyncForRestore, resumeSyncAfterRestore } from '../sync/syncRestoreControl';

/** Attente maximale d'un cycle de synchro ou d'un passage des rappels avant de refuser la restauration. */
export const QUIESCE_TIMEOUT_MS = 10_000;

export interface QuiesceHandle {
  /** Relance ce qui a été arrêté (restauration refusée AVANT la fermeture de la base). */
  release(): void;
}

/**
 * Mise au calme avant le remplacement de la base (P-04-iOS critère 6, ADR 0009 avenant lot F B4 ; PC compris, la feuille est partagée) :
 * synchro (planificateur suspendu, cycle en cours attendu 10 s au plus), rappels et file d'actions N-03 (coordinateur suspendu, passage
 * en cours attendu ; les actions sont vidées par ce passage). Le planificateur de sauvegardes ne lance rien pendant une restauration
 * (`backupStore`, `isRestoring`). `sync-busy` / `busy` : rien n'est modifié, tout est relâché, l'utilisateur peut réessayer.
 */
export async function quiesceForRestore(container: AppContainer, timeoutMs: number = QUIESCE_TIMEOUT_MS): Promise<QuiesceHandle | 'sync-busy' | 'busy'> {
  const runner = getNotificationRunner(container);
  // Revue I3 : drapeau posé d'abord (synchro de toute origine, agendas, Rappels Apple refusés), puis attente de ce qui est parti.
  setRestoreQuiet(true);
  const release = (): void => {
    setRestoreQuiet(false);
    runner.resume();
    resumeSyncAfterRestore(container);
  };
  if (!(await pauseSyncForRestore(container, timeoutMs))) {
    release();
    return 'sync-busy';
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const paused = await Promise.race([runner.pause().then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)))]);
  if (timer !== undefined) clearTimeout(timer);
  if (!paused || !(await quietWorkSettled(timeoutMs))) {
    release();
    return 'busy';
  }
  return { release };
}
