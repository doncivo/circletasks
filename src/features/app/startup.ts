import type { TimeZoneChange } from '../../domain/timeZone';
import { startCalendarScheduler, type CalendarScheduler, type SchedulerEnv } from '../calendars/scheduler';
import type { BackupScheduler } from '../settings/backupScheduler';
import { noteBackupSchedulerLoadFailed } from '../settings/backupSchedulerStatus';
import { logFailure } from '../../platform/desktop/log';
import { createDayRollover, type Timers } from '../tasks/dayRollover';
import { goalsStore } from '../goals/goalsStore';
import { createTrashUseCases } from '../tasks/trashUseCases';
import { useAppStore } from './appStore';
import type { AppContainer } from './container';
import { getNotificationRunner } from '../reminders/notificationRunner';
import { createTimeZoneWatcher } from './timeZoneWatcher';
import { announcePendingRestore } from '../settings/restoreMemoPeek';
import type { FirstCycleGate } from './syncGate';

export interface AppStartup {
  /**
   * Premier rendu possible : sans synchro configurée, le premier contrôle de report est terminé (avant le premier rendu d'Aujourd'hui) ;
   * avec une synchro configurée, il attend la porte de synchro et `ready` ne l'attend pas (T-TECH-01). Ne rejette jamais.
   */
  readonly ready: Promise<void>;
  /** T-TECH-01 : premier contrôle (génération, report) terminé, porte de synchro comprise. Ne rejette jamais. */
  readonly firstCheck: Promise<void>;
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
  /** Minuterie de 12 s de la porte de synchro (tests : horloge simulée) ; défaut : minuteur du système. */
  readonly gateTimers?: Timers;
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
 * T-TECH-01 (B8) : avec une synchro configurée, le premier contrôle attend le premier cycle conclu, ou 12 s (`syncGate.ts`), sans bloquer
 * `ready` ; au premier cycle réussi, le nettoyage des doublons d'occurrences passe d'abord (`recurrenceDedup.ts`, une fois par appareil).
 */
export function startAppStartup(
  container: AppContainer,
  env: StartupEnv = { document, window },
): AppStartup {
  // Revue du lot F : avec une file d'actions N-03 (iPhone), le mémo reste jusqu'à son nettoyage.
  announcePendingRestore({ actionQueue: container.notificationActions !== null });
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
    (error: unknown) => {
      noteBackupSchedulerLoadFailed();
      logFailure('backup-daily', error);
    },
  );
  // Les contrôles suivants ne repassent pas par la porte ; avant l'ouverture de la porte ils attendent (aucun report sur une base périmée).
  let checking = false;
  const onCheck = (): void => {
    if (env.document.visibilityState !== 'hidden') {
      void timeZone.check().then(() => (checking ? rollover.check() : undefined));
      void calendars.resume();
    }
  };
  env.document.addEventListener('visibilitychange', onCheck);
  env.window.addEventListener('focus', onCheck);
  let disposed = false;
  let gate: FirstCycleGate | null = null;
  let first: Promise<void> = Promise.resolve();
  const ready = timeZone
    .check()
    .then(async () => {
      const { sync, syncPlatform } = container;
      if (disposed || !sync || !syncPlatform) return null;
      // Module à la demande ; s'il ne charge pas, le journal le dit et le premier contrôle part tout de suite (comportement d'avant).
      return import('./syncGate').then((module) => module.startFirstCycleGate(sync, syncPlatform, env.gateTimers), (error: unknown) => (logFailure('sync', error), null));
    })
    .then((opened) => {
      gate = opened;
      first = (async () => {
        if (opened?.waits) {
          // Premier cycle réussi : nettoyage des doublons d'occurrences avant le report ; un échec est journalisé, nouvel essai au démarrage suivant.
          if ((await opened.outcome) === 'done' && !disposed) await import('../tasks/recurrenceDedup').then((module) => module.runRecurrenceDedupOnce(container)).catch((error: unknown) => logFailure('recurrence', error));
        }
        if (disposed) return;
        await rollover.start();
        checking = true;
      })();
      return opened?.waits ? undefined : first;
    });
  void ready.then(() => createTrashUseCases(container).purgeExpired()).catch(() => undefined);
  return {
    ready,
    firstCheck: ready.then(() => first),
    calendars,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      gate?.cancel();
      calendars.dispose();
      backups?.dispose();
      env.document.removeEventListener('visibilitychange', onCheck);
      env.window.removeEventListener('focus', onCheck);
      rollover.stop();
    },
  };
}
