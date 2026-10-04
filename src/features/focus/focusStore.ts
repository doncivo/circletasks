import { createStore } from 'zustand';
import { endAtMs, isElapsed, notificationFireAtMs, type FocusDuration } from '../../domain/focusSession';
import { focusTotalMinutes } from '../../domain/focusTotals';
import type { FocusSession, Task } from '../../domain/model';
import type { LocalTime, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createFocusUseCases, type FocusUseCases, type StartOutcome } from './focusUseCases';

/** Tâche de la session, lue au lancement ; la fiche à jour vient de `taskEntities` tant qu'elle y est (le titre peut changer en route). */
export interface FocusTaskInfo {
  readonly id: TaskId;
  readonly title: string;
  readonly time: LocalTime | null;
  readonly status: Task['status'];
}

/** Session close qui reste affichée : « Session terminée » (F-04) ; `minutes` : temps de concentration enregistré. */
export interface FocusEndedView {
  readonly session: FocusSession;
  readonly minutes: number;
}

export type FocusStartResult = StartOutcome['status'] | 'error';

export interface FocusState {
  /** Réglages et session ouverte lus (après `restore`). */
  readonly ready: boolean;
  /** Session ouverte (en cours ou en pause), null sinon. */
  readonly session: FocusSession | null;
  /** Session terminée encore affichée (F-04) ; null sinon. */
  readonly ended: FocusEndedView | null;
  readonly task: FocusTaskInfo | null;
  /** Dernière durée choisie (F-01 critère 12). */
  readonly duration: FocusDuration;
  /** Pied de l'écran (F-03) : concentration d'aujourd'hui, sessions terminées de tous les espaces. */
  readonly today: { readonly minutes: number; readonly sessions: number };
  /** Son de fin de session activé (Réglages › TÂCHES, local, activé par défaut, F-04 critère 3). */
  readonly endSound: boolean;
  /** Incrémenté à chaque fin à signaler par un son (F-04) ; reste inchangé pour une fin silencieuse (retour après fermeture). */
  readonly soundNonce: number;
  /** Incrémenté à chaque session close ou supprimée : relance les totaux affichés (F-03). */
  readonly revision: number;
  /** Lit les réglages, la session ouverte (F-01 critère 9) et ferme au terme prévu celle qui l'a dépassé en l'absence de l'app. */
  restore(): Promise<void>;
  /** F-01 critères 1 à 6 : lance une session sur la tâche avec la dernière durée. */
  start(taskId: TaskId): Promise<FocusStartResult>;
  /** F-01 critère 4 : change la durée prévue (mémorisée pour le prochain lancement). */
  setDuration(duration: FocusDuration): Promise<void>;
  /** F-02 critère 1 : met la session en pause (le minuteur s'arrête, `paused_at` est écrit). */
  pause(): Promise<void>;
  /** F-02 critère 2 : reprend la session (la pause s'ajoute à `paused_sec`). */
  resume(): Promise<void>;
  /** F-01 critère 7 : arrêt volontaire (la vue a déjà demandé confirmation). */
  stop(): Promise<void>;
  /** F-01 critère 8 : arrête la session et termine la tâche. */
  finishTask(): Promise<void>;
  /** Terme atteint ? Idempotent : sans effet tant que le temps actif n'a pas atteint la durée prévue. */
  checkElapsed(): Promise<void>;
  /** La tâche a pu être supprimée ou terminée ailleurs : relit sa fiche (la session continue, F-01 critère 10). */
  refreshTask(): Promise<void>;
  /** Ferme l'écran de session terminée (F-04), la tâche reste inchangée. */
  dismissEnded(): void;
  /** F-04 critère 4 : « Une autre session » : même durée, nouvelle session sur la même tâche. */
  another(): Promise<void>;
  /** F-04 critère 3 : interrupteur « Son de fin de session » (réglage local). */
  setEndSound(enabled: boolean): void;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const focusStore = defineFeatureStore<FocusState>((container) => createFocusStore(container));

function taskInfoOf(task: Task): FocusTaskInfo {
  return { id: task.id, title: task.title, time: task.time, status: task.status };
}

function createFocusStore(container: AppContainer) {
  const useCases: FocusUseCases = createFocusUseCases(container);
  const { clock, focusEndScheduler: scheduler } = container;

  // Les actions s'exécutent l'une après l'autre : un tic de fin, un arrêt et une pause simultanés ne se marchent pas dessus.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work, work);
    chain = run.catch(() => undefined);
    return run;
  };

  let endTimer: ReturnType<typeof setTimeout> | null = null;

  return createStore<FocusState>()((set, get) => {
    /** Programme le contrôle du terme. La minuterie n'est qu'un réveil : l'instant exact est toujours recalculé par horodatage. */
    function armEndTimer(): void {
      if (endTimer !== null) clearTimeout(endTimer);
      endTimer = null;
      const { session } = get();
      if (!session || session.pausedAt !== null) return;
      const delay = Math.min(Math.max(0, endAtMs(session) - clock.nowMs()) + 20, MAX_TIMEOUT_MS);
      endTimer = setTimeout(() => void get().checkElapsed(), delay);
    }

    /**
     * Notification de fin (iPhone, F-04 critères 8 et 9) : planifiée au lancement et à la reprise, annulée à la pause, à l'arrêt et à
     * la fin ; recalculée à chaque changement de durée. Meilleur effort : un échec n'interrompt jamais la session.
     */
    function syncSchedule(): void {
      const { session, task } = get();
      if (!session) return;
      const fireAt = notificationFireAtMs(session);
      const work = fireAt === null ? scheduler.cancel(session.id) : scheduler.schedule(session.id, new Date(fireAt), task?.title ?? t('focus.windowTitle'));
      void work.catch(() => undefined);
    }

    function cancelSchedule(sessionId: string): void {
      void scheduler.cancel(sessionId).catch(() => undefined);
    }

    /** Relit le total du jour (F-03) ; une erreur de lecture laisse la valeur précédente. */
    async function refreshToday(): Promise<void> {
      try {
        const total = await useCases.todayTotals();
        set({ today: { minutes: focusTotalMinutes(total), sessions: total.sessions } });
      } catch {
        // Pied d'écran indicatif : on garde la valeur précédente.
      }
    }

    function closed(session: FocusSession, minutes: number, silent: boolean): void {
      cancelSchedule(session.id);
      set((s) => ({
        session: null,
        ended: { session, minutes },
        soundNonce: silent ? s.soundNonce : s.soundNonce + 1,
        revision: s.revision + 1,
      }));
      armEndTimer();
    }

    /** Clôt la session si son terme est atteint (à appeler dans une action sérialisée). */
    async function closeIfElapsed(): Promise<void> {
      const { session } = get();
      if (!session || !isElapsed(session, clock.nowMs())) return;
      const result = await useCases.closeAtTerm(session);
      closed(result.session, result.minutes, false);
      await refreshToday();
    }

    async function loadTask(session: FocusSession): Promise<FocusTaskInfo | null> {
      if (!session.taskId) return null;
      try {
        const task = await useCases.getTask(session.taskId);
        return task ? taskInfoOf(task) : null;
      } catch {
        return null;
      }
    }

    return {
      ready: false,
      session: null,
      ended: null,
      task: null,
      duration: 25,
      today: { minutes: 0, sessions: 0 },
      endSound: true,
      soundNonce: 0,
      revision: 0,

      restore: () =>
        serial(async () => {
          const duration = await useCases.lastDuration().catch((): FocusDuration => 25);
          const endSound = await useCases.endSoundEnabled().catch(() => true);
          const outcome = await useCases.restore().catch(() => ({ status: 'none' as const }));
          if (outcome.status === 'open') {
            set({ ready: true, duration, endSound, session: outcome.session, ended: null, task: await loadTask(outcome.session) });
            armEndTimer();
            syncSchedule();
            // Terme dépassé depuis moins d'une minute : la fin se déroule normalement, avec son.
            if (isElapsed(outcome.session, clock.nowMs())) await closeIfElapsed();
          } else if (outcome.status === 'closed') {
            set({ ready: true, duration, endSound, task: await loadTask(outcome.session) });
            closed(outcome.session, outcome.minutes, true);
          } else {
            set({ ready: true, duration, endSound });
          }
          await refreshToday();
        }),

      start: (taskId) =>
        serial(async (): Promise<FocusStartResult> => {
          try {
            const duration = await useCases.lastDuration();
            const outcome = await useCases.start(taskId, duration);
            if (outcome.status === 'busy') {
              set((s) => (s.session ? s : { session: outcome.session, ended: null }));
              return 'busy';
            }
            if (outcome.status === 'unavailable') return 'unavailable';
            set({ session: outcome.session, ended: null, task: taskInfoOf(outcome.task), duration });
            armEndTimer();
            syncSchedule();
            await refreshToday();
            return 'started';
          } catch {
            return 'error';
          }
        }),

      setDuration: (duration) =>
        serial(async () => {
          const { session } = get();
          set({ duration });
          await useCases.rememberDuration(duration).catch(() => undefined);
          if (!session) return;
          const updated = await useCases.setDuration(session, duration);
          set({ session: updated });
          armEndTimer();
          syncSchedule();
          // Temps restant ≤ 0 avec la nouvelle durée : la session se termine (F-01 critère 4, F-04).
          if (isElapsed(updated, clock.nowMs())) await closeIfElapsed();
        }),

      pause: () =>
        serial(async () => {
          const { session } = get();
          if (!session || session.pausedAt !== null) return;
          set({ session: await useCases.pause(session) });
          // En pause, aucune fin n'est attendue : le réveil et la notification sont annulés, recalculés à la reprise (F-02 critère 8).
          armEndTimer();
          syncSchedule();
        }),

      resume: () =>
        serial(async () => {
          const { session } = get();
          if (!session || session.pausedAt === null) return;
          set({ session: await useCases.resume(session) });
          armEndTimer();
          syncSchedule();
        }),

      stop: () =>
        serial(async () => {
          const { session } = get();
          if (!session) return;
          await useCases.stop(session);
          cancelSchedule(session.id);
          set((s) => ({ session: null, ended: null, task: null, revision: s.revision + 1 }));
          armEndTimer();
          await refreshToday();
        }),

      finishTask: () =>
        serial(async () => {
          const { session, ended } = get();
          if (session) {
            await useCases.finishWithTask(session);
            cancelSchedule(session.id);
          } else if (ended?.session.taskId) {
            // État « Session terminée » (F-04) : la session est déjà enregistrée, seule la tâche reste à terminer.
            const task = await useCases.getTask(ended.session.taskId);
            if (task && task.status === 'todo') await useCases.completeTask(task.id);
          } else {
            return;
          }
          set((s) => ({ session: null, ended: null, task: null, revision: s.revision + 1 }));
          armEndTimer();
          await refreshToday();
        }),

      checkElapsed: () => serial(closeIfElapsed),

      refreshTask: async () => {
        const { session, ended } = get();
        const current = session ?? ended?.session ?? null;
        if (!current) return;
        const info = await loadTask(current);
        const now = get();
        if ((now.session ?? now.ended?.session ?? null)?.id === current.id) set({ task: info });
      },

      dismissEnded: () => set({ ended: null, task: null }),

      another: () =>
        serial(async () => {
          const { ended } = get();
          if (!ended?.session.taskId) return;
          try {
            // Même durée que la session qui vient de se terminer (critère 4), sans changer la durée mémorisée.
            const outcome = await useCases.start(ended.session.taskId, ended.session.plannedMin === 25 || ended.session.plannedMin === 50 || ended.session.plannedMin === 90 ? ended.session.plannedMin : null);
            if (outcome.status === 'started') {
              set({ session: outcome.session, ended: null, task: taskInfoOf(outcome.task) });
              armEndTimer();
              syncSchedule();
              await refreshToday();
            } else {
              // Tâche supprimée ou terminée entre-temps : il n'y a plus de session à relancer, l'écran se ferme.
              set({ ended: null, task: null });
            }
          } catch {
            set({ ended: null, task: null });
          }
        }),

      setEndSound: (enabled) => {
        set({ endSound: enabled });
        void useCases.setEndSound(enabled).catch(() => undefined);
      },
    };
  });
}
