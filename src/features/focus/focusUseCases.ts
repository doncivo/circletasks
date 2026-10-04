import { nowIso, todayLocal } from '../../domain/clock';
import {
  FOCUS_OVERDUE_GRACE_MS,
  closeAtTerm,
  focusPlacementAtLaunch,
  isElapsed,
  isTooShortToKeep,
  pauseValues,
  resumeValues,
  overdueMs,
  sanitizeFocusDuration,
  stopValues,
  type FocusDuration,
} from '../../domain/focusSession';
import { daySpan, type FocusTotal } from '../../domain/focusTotals';
import { ALL_ITEMS } from '../../domain/itemFilter';
import type { FocusSession, Task } from '../../domain/model';
import { newEntityId } from '../../domain/id';
import type { FocusSessionId, IsoDateTime, TaskId } from '../../domain/types';
import type { AppContainer } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';

/**
 * Cas d'usage du Focus (M10, F-01 à F-04). Les règles (minuteur, terme, plafond, durée minimale) sont dans
 * `src/domain/focusSession.ts` ; ici seulement la séquence lecture / règle / écriture. Aucune horloge n'est lue ailleurs que dans
 * `deps.clock`, et jamais pour compter : seulement pour dater un événement (lancement, arrêt).
 */
export type FocusUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'>;

export type StartOutcome =
  | { readonly status: 'started'; readonly session: FocusSession; readonly task: Task }
  /** Une session est déjà ouverte (F-01 critère 6) : on la rend pour ramener sa fenêtre au premier plan. */
  | { readonly status: 'busy'; readonly session: FocusSession }
  /** Tâche introuvable, supprimée ou déjà terminée. */
  | { readonly status: 'unavailable' };

export type StopOutcome =
  | { readonly status: 'saved'; readonly session: FocusSession; readonly minutes: number }
  /** Moins d'une minute de temps actif : supprimée sans trace (F-01 critère 7). */
  | { readonly status: 'discarded' };

export type RestoreOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'open'; readonly session: FocusSession }
  /** Terme dépassé de plus d'une minute pendant que l'app était fermée : close à son terme, sans son (F-04 critère 5). */
  | { readonly status: 'closed'; readonly session: FocusSession; readonly minutes: number };

export interface FocusUseCases {
  /** Lit la session ouverte ; null s'il n'y en a pas. */
  getOpen(): Promise<FocusSession | null>;
  /** Tâche (vivante) d'une session, null si elle a disparu. */
  getTask(taskId: TaskId): Promise<Task | null>;
  /** F-03 critères 1 et 2 : concentration du jour (toutes les sessions terminées, tous espaces : le pied ignore le filtre). */
  todayTotals(): Promise<FocusTotal>;
  /** F-04 critère 3 : réglage « Son de fin de session » (activé par défaut). */
  endSoundEnabled(): Promise<boolean>;
  setEndSound(enabled: boolean): Promise<void>;
  /** F-01 critère 12 : dernière durée choisie (25 min au départ). */
  lastDuration(): Promise<FocusDuration>;
  rememberDuration(duration: FocusDuration): Promise<void>;
  /** F-01 critères 1, 5, 6 : enregistre la session dès le lancement. `durationMin` : null = « Libre ». */
  start(taskId: TaskId, durationMin: FocusDuration): Promise<StartOutcome>;
  /** F-01 critère 4 : change la durée prévue de la session ouverte. */
  setDuration(session: FocusSession, durationMin: FocusDuration): Promise<FocusSession>;
  /** F-02 critère 1 : met en pause à l'instant courant (écrit `paused_at`) ; la session inchangée si elle l'est déjà. */
  pause(session: FocusSession): Promise<FocusSession>;
  /** F-02 critère 2 : reprend (la pause s'ajoute à `paused_sec`, `paused_at` est vidé) ; la session inchangée si elle court. */
  resume(session: FocusSession): Promise<FocusSession>;
  /** F-01 critère 7 : arrêt volontaire à l'instant courant. */
  stop(session: FocusSession): Promise<StopOutcome>;
  /** F-04 critère 1 : clôture à son terme prévu, sans temps supplémentaire. */
  closeAtTerm(session: FocusSession): Promise<{ readonly session: FocusSession; readonly minutes: number }>;
  /** Termine la tâche (T-04, T-09), annulable 5 s : état « Session terminée » (F-04). */
  completeTask(taskId: TaskId): Promise<Task>;
  /** F-01 critère 8 : arrête la session puis termine la tâche (T-04, T-09), annulable 5 s. */
  finishWithTask(session: FocusSession): Promise<StopOutcome>;
  /** F-01 critère 9 : état exact au redémarrage, ou clôture au terme prévu. */
  restore(): Promise<RestoreOutcome>;
}

export function createFocusUseCases(deps: FocusUseCaseDeps): FocusUseCases {
  const { data, clock } = deps;
  const taskUseCases = createTaskUseCases(deps);

  async function loadTask(taskId: TaskId): Promise<Task | null> {
    const cached = deps.taskEntities.get(taskId);
    if (cached && cached.deletedAt === null) return cached;
    return data.repos.tasks.getById(taskId);
  }

  function minutesOf(session: FocusSession): number {
    return Math.floor((Date.parse(session.endedAt ?? nowIso(clock)) - Date.parse(session.startedAt) - session.pausedSec * 1000) / 60_000);
  }

  async function close(session: FocusSession, at: IsoDateTime): Promise<FocusSession> {
    return data.repos.focusSessions.update(session.id, stopValues(session, at));
  }

  async function stopSession(session: FocusSession): Promise<StopOutcome> {
    const now = clock.nowMs();
    if (isTooShortToKeep(session, now)) {
      await data.repos.focusSessions.discard(session.id);
      return { status: 'discarded' };
    }
    const closed = await close(session, nowIso(clock));
    return { status: 'saved', session: closed, minutes: minutesOf(closed) };
  }

  async function closeSessionAtTerm(session: FocusSession): Promise<{ readonly session: FocusSession; readonly minutes: number }> {
    const closed = await close(session, closeAtTerm(session));
    return { session: closed, minutes: minutesOf(closed) };
  }

  return {
    getOpen: () => data.repos.focusSessions.getOpen(),
    getTask: loadTask,

    async lastDuration() {
      return sanitizeFocusDuration(await data.repos.settings.get('focus.lastDuration'));
    },

    todayTotals: () => data.repos.focusSessions.totals({ span: daySpan(todayLocal(clock)), filter: ALL_ITEMS }),
    endSoundEnabled: () => data.repos.settings.get('focus.endSound'),
    setEndSound: (enabled) => data.repos.settings.set('focus.endSound', enabled),

    async rememberDuration(duration) {
      await data.repos.settings.set('focus.lastDuration', duration);
    },

    async start(taskId, durationMin) {
      const open = await data.repos.focusSessions.getOpen();
      if (open) return { status: 'busy', session: open };
      const task = await loadTask(taskId);
      if (!task || task.status === 'done') return { status: 'unavailable' };
      // ES-08 : l'espace de la session est celui de la tâche (le projet est celui de la tâche, non stocké).
      const placement = focusPlacementAtLaunch(task, 'all', []);
      if (!placement) return { status: 'unavailable' };
      const session = await data.repos.focusSessions.create({
        id: newEntityId<FocusSessionId>(deps.ids),
        taskId,
        spaceId: placement.spaceId,
        projectId: placement.projectId,
        plannedMin: durationMin,
        startedAt: nowIso(clock),
      });
      return { status: 'started', session, task };
    },

    async setDuration(session, durationMin) {
      return data.repos.focusSessions.update(session.id, { plannedMin: durationMin });
    },

    completeTask: (taskId) => taskUseCases.complete(taskId),
    async pause(session) {
      const values = pauseValues(session, nowIso(clock));
      return values ? data.repos.focusSessions.update(session.id, values) : session;
    },

    async resume(session) {
      const values = resumeValues(session, nowIso(clock));
      return values ? data.repos.focusSessions.update(session.id, values) : session;
    },

    stop: stopSession,
    closeAtTerm: closeSessionAtTerm,

    async finishWithTask(session) {
      const outcome = await stopSession(session);
      const task = session.taskId ? await data.repos.tasks.getById(session.taskId) : null;
      // La tâche a pu être supprimée ou terminée pendant la session : la session est enregistrée, rien d'autre à faire.
      if (task && task.status === 'todo') await taskUseCases.complete(task.id);
      return outcome;
    },

    async restore() {
      const open = await data.repos.focusSessions.getOpen();
      if (!open) return { status: 'none' };
      const now = clock.nowMs();
      if (isElapsed(open, now) && overdueMs(open, now) > FOCUS_OVERDUE_GRACE_MS) {
        const closed = await closeSessionAtTerm(open);
        return { status: 'closed', ...closed };
      }
      return { status: 'open', session: open };
    },
  };
}
