import type { TimeZoneChange } from '../../domain/timeZone';
import { startCalendarScheduler, type CalendarScheduler, type SchedulerEnv } from '../calendars/scheduler';
import type { BackupScheduler } from '../settings/backupScheduler';
import { logFailure } from '../../platform/desktop/log';
import { createDayRollover } from '../tasks/dayRollover';
import { goalsStore } from '../goals/goalsStore';
import { createTrashUseCases } from '../tasks/trashUseCases';
import { useAppStore } from './appStore';
import type { AppContainer } from './container';
import { getNotificationRunner } from '../reminders/notificationRunner';
import { createTimeZoneWatcher } from './timeZoneWatcher';
import { announcePendingRestore } from '../settings/restoreMemoPeek';

export interface AppStartup {
  /** Premier contrôle de report terminé (avant le premier rendu d'Aujourd'hui). Ne rejette jamais. */
  readonly ready: Promise<void>;
  /** K-03 : rafraîchissement des agendas externes (ouverture, retour au premier plan, toutes les 15 min au premier plan). */
  readonly calendars: CalendarScheduler;
  /** Arrête minuterie et écouteurs ; sûr avant la fin de `ready` (aucun réarmement ensuite) et idempotent. */
  dispose(): void;
}

/** Cibles d'événements injectables (tests). */
export interface StartupEnv {
  readonly document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Détection du fuseau (tests) ; défaut : fuseau du système. */
  readonly detectTimeZone?: () => string | null;
  /** Point d'extension N-06 : replanification des rappels après un changement de fuseau. */
  readonly onTimeZoneChange?: (change: TimeZoneChange) => void | Promise<void>;
  /** Minuteur du rafraîchissement des agendas (tests : horloge simulée) ; défaut : minuteur du système. */
  readonly timers?: Pick<SchedulerEnv, 'setInterval' | 'clearInterval'>;
}

/**
 * Orchestration de démarrage (T-06) : premier contrôle du report, minuterie de minuit
 * (bornée à 60 s côté rollover, robuste à la veille du PC) et contrôles au retour au
 * premier plan (`visibilitychange`) et à la prise de focus de la fenêtre (`focus`).
 * T-11 : détection du fuseau au démarrage et au retour au premier plan (`general.timeZone`).
 * OB-05 : à chaque changement de jour (dont le premier contrôle), les objectifs de la semaine passée restés ouverts sont proposés
 * (reconduire ou clore) ; le jour vient de l'horloge injectable du conteneur.
 * T-08 : purge de la corbeille (tâches supprimées depuis plus de 30 jours) lancée au démarrage,
 * sans bloquer `ready` ; un échec est sans conséquence (nouvelle tentative au prochain démarrage).
 * K-03 : les agendas externes sont rafraîchis dès l'ouverture puis toutes les 15 min au premier plan (`startCalendarScheduler`), sans bloquer `ready`.
 */
export function startAppStartup(
  container: AppContainer,
  env: StartupEnv = { document, window },
): AppStartup {
  announcePendingRestore();
  const rollover = createDayRollover(container, {
    onDayChange: (day) => {
      useAppStore.getState().setDay(day);
      // OB-05 : au démarrage et à chaque changement de jour, les objectifs ouverts d'une semaine terminée sont (re)proposés.
      void goalsStore.get(container).getState().loadReviews(day);
    },
    onCarryOverResult: (failed) => useAppStore.getState().setCarryOverFailed(failed),
    onRecurrenceResult: (failed) => useAppStore.getState().setRecurrenceFailed(failed),
  });
  // T-11 : le fuseau est vérifié AVANT le report, pour que « Aujourd'hui » suive la date locale nouvelle.
  const timeZone = createTimeZoneWatcher(container, {
    ...(env.detectTimeZone ? { detect: env.detectTimeZone } : {}),
    onCurrent: (tz) => useAppStore.getState().setTimeZone(tz),
    // N-06 : un changement de fuseau replanifie les rappels (l'instant de chacun change, le déclencheur iOS est relatif).
    onChange: async (change) => {
      await env.onTimeZoneChange?.(change);
      void getNotificationRunner(container).request('zone');
    },
  });
  const calendars = startCalendarScheduler(container, { document: env.document, ...(env.timers ?? {}) });
  // P-04 : sauvegarde quotidienne à l'ouverture, au retour au premier plan et après minuit (sans bloquer le démarrage).
  // Chargé à la demande (bundle de départ, PRD 8) : la première vérification part dès l'arrivée du module, sans bloquer `ready`.
  let backups: BackupScheduler | null = null;
  void import('../settings/backupScheduler').then(
    (module) => {
      if (!disposed) backups = module.startBackupScheduler(container, { document: env.document, window: env.window, ...(env.timers ?? {}) });
    },
    (error: unknown) => logFailure('backup-daily', error),
  );
  const onCheck = (): void => {
    if (env.document.visibilityState !== 'hidden') {
      void timeZone.check().then(() => rollover.check());
      void calendars.resume();
    }
  };
  env.document.addEventListener('visibilitychange', onCheck);
  env.window.addEventListener('focus', onCheck);
  let disposed = false;
  const ready = timeZone.check().then(() => (disposed ? undefined : rollover.start()));
  void ready.then(() => createTrashUseCases(container).purgeExpired()).catch(() => undefined);
  return {
    ready,
    calendars,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      calendars.dispose();
      backups?.dispose();
      env.document.removeEventListener('visibilitychange', onCheck);
      env.window.removeEventListener('focus', onCheck);
      rollover.stop();
    },
  };
}
