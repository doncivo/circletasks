import { createStore } from 'zustand';
import { addDays } from '../../domain/localDate';
import type { CalendarAccount, ExternalEvent, IconRef, RecurrenceFields, ReminderOffsetMin, Task } from '../../domain/model';
import type { SeriesScope } from '../../domain/recurrenceEdit';
import type { PostponeTarget } from '../../domain/taskPostpone';
import { moveTaskRow, type MoveOutcome } from '../../domain/taskReorder';
import { matchesItemFilter } from '../../domain/itemFilter';
import type { TodayRow } from '../../domain/todayList';
import type { WeekDayExtras } from '../../domain/week';
import { weekDays } from '../../domain/week';
import type { InstantRange } from '../../db/repositories';
import type { GoalId, IsoDateTime, LocalDate, LocalTime, ProjectId, RecurrenceId, Result, RoutineId, SpaceFilter, SpaceId, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createSeriesUseCases } from '../tasks/seriesUseCases';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import type { CreateTaskError } from '../tasks/taskUseCases';
import { EMPTY_TODAY_EXTRAS, loadTodayExtras, toggleRoutineViaSources } from '../today/todaySources';

export type WeekStatus = 'idle' | 'loading' | 'ready' | 'error';

/** Tâche à créer depuis la Semaine (bouton « + » : feuille complète ; S-04 : champ de saisie d'un jour). */
export interface NewWeekTask {
  readonly title: string;
  readonly spaceId: SpaceId;
  /** ES-04 : projet de la tâche (de l'espace choisi) ; absent : aucun. */
  readonly projectId?: ProjectId | null;
  /** Jour de la tâche ; null avec `someday` : « Un jour ». */
  readonly date: LocalDate | null;
  readonly time?: LocalTime | null;
  readonly someday?: boolean;
  readonly recurrence?: RecurrenceFields | null;
  readonly icon?: IconRef | null;
  /** N-02 : avances des rappels choisies dans la feuille d'ajout. */
  readonly reminderOffsets?: readonly ReminderOffsetMin[];
  /** OB-03 : objectif auquel la tâche est rattachée à sa création (feuille d'ajout). */
  readonly goalId?: GoalId | null;
}

/** `addTask` peut en plus échouer pour une raison imprévue (écriture en base). */
export type WeekAddTaskError = CreateTaskError | 'unexpected';

/**
 * État et actions de la Semaine (M3, S-01). Une instance par conteneur (`defineFeatureStore`, ADR 0004). Les tâches ne sont pas
 * recopiées ici : `load` les publie dans `container.taskEntities` (source unique) et l'écran sélectionne celles de la semaine
 * affichée (`selectWeekTasks`) ; une tâche créée, déplacée ou datée depuis une autre vue (fiche détail) rejoint donc la grille
 * sans rechargement.
 */
export interface WeekState {
  /** Lundi de la semaine chargée ; null avant le premier chargement. */
  readonly weekStart: LocalDate | null;
  readonly filter: SpaceFilter;
  /** Règles des séries affichées (T-09) : sous-ligne « mensuelle ». */
  readonly recurrences: ReadonlyMap<RecurrenceId, RecurrenceFields>;
  /** Routines, événements locaux et checklists de chaque jour, fournis par leurs modules (`todaySources`) ; vides tant qu'ils n'existent pas. */
  readonly extras: ReadonlyMap<LocalDate, WeekDayExtras>;
  /**
   * Événements des agendas externes de la semaine (S-05), tels que lus en base (instants UTC) : l'écran les convertit dans le fuseau
   * courant et les filtre par espace à chaque rendu (`externalEventsByDay`), donc un changement de fuseau les recale sans relecture.
   */
  readonly externalEvents: readonly ExternalEvent[];
  /** Comptes d'agenda (rattachement des agendas à un espace, nom de la source). */
  readonly calendarAccounts: readonly CalendarAccount[];
  /** Une source d'éléments de la semaine a échoué : message dédié, les tâches restent affichées. */
  readonly extrasFailed: boolean;
  readonly status: WeekStatus;
  /** Clé i18n du message à afficher quand `status` vaut 'error'. */
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action sur une tâche (terminer, rouvrir) : message dédié, la grille reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** (Re)charge la semaine commençant le lundi `weekStart` pour le filtre d'espace donné. Ne rejette jamais. */
  load(weekStart: LocalDate, filter: SpaceFilter): Promise<void>;
  /**
   * Crée une tâche (T-01, S-04) : le cas d'usage la publie dans la source unique, elle apparaît dans la grille si son jour y est et
   * si son espace correspond au filtre. Ne rejette jamais : les échecs sont renvoyés dans le `Result`.
   */
  addTask(input: NewWeekTask): Promise<Result<Task, WeekAddTaskError>>;
  /**
   * S-02 : déplace une tâche vers un autre jour (glisser-déposer, Alt+←/→) : la date est écrite et publiée aussitôt, annulable
   * (T-13). Pour une occurrence récurrente, ne déplace que cette occurrence, sans question. Ne rejette jamais.
   */
  moveToDay(id: TaskId, date: LocalDate): Promise<void>;
  /** S-02 critère 9 : Ctrl+D, reporte la tâche choisie (T-05) ; annulable. Ne rejette jamais. */
  postpone(id: TaskId, target: PostponeTarget): Promise<boolean>;
  /** S-02, T-10 : report d'une occurrence récurrente pour « cette occurrence » ou « toutes les suivantes ». Ne rejette jamais. */
  postponeSeries(id: TaskId, target: PostponeTarget, scope: SeriesScope): Promise<boolean>;
  /** A-07 : bouton « Un jour » du balayage (SD-03) ; annulable. Rend vrai si la tâche est rangée, sinon `actionErrorKey` est posé. Ne rejette jamais. */
  sendToSomeday(id: TaskId): Promise<boolean>;
  /** A-07 : suppression confirmée depuis le balayage (T-08, T-10 pour une série) ; annulable. Ne rejette jamais. */
  remove(id: TaskId, scope?: SeriesScope): Promise<boolean>;
  /**
   * S-02 critère 10 : réordonne dans un même jour (A-02, Q11) : seul l'ordre entre tâches sans heure (ou de même heure) change.
   * Renvoie le résultat (null : élément non déplaçable ou échec). Ne rejette jamais.
   */
  moveRow(rows: readonly TodayRow[], id: string, toIndex: number): Promise<MoveOutcome | null>;
  /** Termine ou rouvre une tâche (T-04, case de la carte). Ne rejette jamais. */
  toggleDone(id: TaskId): Promise<boolean>;
  /** R-03 : valide ou annule la validation d'une routine d'un jour de la semaine. Ne rejette jamais. */
  toggleRoutine(id: RoutineId, date: LocalDate): Promise<boolean>;
  /** Relit les éléments des autres modules des sept jours (une routine validée ou annulée ailleurs). Ne rejette jamais. */
  refreshExtras(): Promise<void>;
  /** T-09 : lit les règles des séries affichées pas encore connues. Ne rejette jamais. */
  syncRecurrences(tasks: readonly Task[]): Promise<void>;
}

/**
 * Tâches de la semaine commençant le lundi `weekStart`, lues dans la source unique : datées dans la semaine, ni « Un jour » ni
 * supprimées, dans l'espace du filtre. Le tri par jour est celui du domaine (`buildWeek`).
 */
export function selectWeekTasks(entities: ReadonlyMap<TaskId, Task>, weekStart: LocalDate, filter: SpaceFilter, projectId: ProjectId | null = null): Task[] {
  const end = addDays(weekStart, 6);
  const tasks: Task[] = [];
  for (const task of entities.values()) {
    if (task.deletedAt !== null || task.someday || task.date === null || task.date < weekStart || task.date > end) continue;
    if (!matchesItemFilter(task, { space: filter, project: projectId })) continue;
    tasks.push(task);
  }
  return tasks;
}

/**
 * Plage UTC lue pour une semaine : un jour de marge de chaque côté couvre tous les fuseaux (±14 h) et les journées entières, qui
 * stockent leur date civile en UTC ; le calcul exact par jour local est fait par `externalEventsByDay`.
 */
export function externalEventRange(weekStart: LocalDate): InstantRange {
  return { from: `${addDays(weekStart, -1)}T00:00:00Z` as IsoDateTime, to: `${addDays(weekStart, 8)}T00:00:00Z` as IsoDateTime };
}

export const weekStore = defineFeatureStore<WeekState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  const series = createSeriesUseCases(container);
  // Jeton de requête : le résultat d'un chargement dépassé par un plus récent est ignoré (navigation rapide entre semaines).
  let requestId = 0;
  // Routines (par jour) en cours de validation : un second clic pendant l'écriture est ignoré (R-03 critère 3).
  const routinesBusy = new Set<string>();

  const loadRecurrences = async (
    tasks: readonly Task[],
    known: ReadonlyMap<RecurrenceId, RecurrenceFields>,
  ): Promise<ReadonlyMap<RecurrenceId, RecurrenceFields>> => {
    const missing = [...new Set(tasks.flatMap((task) => (task.recurrenceId && !known.has(task.recurrenceId) ? [task.recurrenceId] : [])))];
    if (missing.length === 0) return known;
    const next = new Map(known);
    for (const id of missing) {
      try {
        const rule = await container.data.repos.recurrences.getById(id);
        if (rule) next.set(id, rule);
      } catch {
        // règle illisible : pas d'indicateur sur la carte
      }
    }
    return next;
  };

  return createStore<WeekState>()((set, get) => ({
    weekStart: null,
    filter: 'all',
    recurrences: new Map<RecurrenceId, RecurrenceFields>(),
    extras: new Map<LocalDate, WeekDayExtras>(),
    externalEvents: [],
    calendarAccounts: [],
    extrasFailed: false,
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(weekStart, filter) {
      const id = ++requestId;
      set({ status: 'loading', weekStart, filter, errorKey: null, actionErrorKey: null });
      try {
        const tasks = await container.data.repos.tasks.listForWeek(weekStart, filter);
        container.taskEntities.publish(tasks);
        const recurrences = await loadRecurrences(tasks, get().recurrences);
        // Un jour à la fois via les sources d'Aujourd'hui (routines, événements locaux, checklists) : aucune tant que leurs modules n'existent pas.
        const loaded = await Promise.all(weekDays(weekStart).map(async (date) => ({ date, ...(await loadTodayExtras(container, date, filter, 'week')) })));
        // Agendas externes (S-05) : lecture seule, une requête pour la semaine ; un échec ne masque pas les tâches.
        let externalEvents: readonly ExternalEvent[] = [];
        let calendarAccounts: readonly CalendarAccount[] = [];
        let externalFailed = false;
        try {
          [externalEvents, calendarAccounts] = await Promise.all([
            container.data.repos.externalEvents.listBetween(externalEventRange(weekStart)),
            container.data.repos.calendarAccounts.listAll(),
          ]);
        } catch {
          externalFailed = true;
        }
        if (id !== requestId) return;
        const extras = new Map<LocalDate, WeekDayExtras>();
        for (const { date, extras: day } of loaded) if (day !== EMPTY_TODAY_EXTRAS) extras.set(date, day);
        set({ recurrences, extras, externalEvents, calendarAccounts, extrasFailed: externalFailed || loaded.some((day) => day.failed), status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'week.loadError' });
      }
    },

    async addTask(input) {
      try {
        return await useCases.create({
          title: input.title,
          spaceId: input.spaceId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          date: input.someday ? null : input.date,
          ...(input.someday ? { someday: true } : {}),
          ...(input.time !== undefined && !input.someday ? { time: input.time } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.recurrence ? { recurrence: input.recurrence } : {}),
          ...(input.reminderOffsets && input.reminderOffsets.length > 0 ? { reminderOffsets: input.reminderOffsets } : {}),
          ...(input.goalId ? { goalId: input.goalId } : {}),
        });
      } catch {
        set({ actionErrorKey: 'week.addError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async moveToDay(id, date) {
      try {
        await useCases.moveToDay(id, date);
        set({ actionErrorKey: null });
      } catch {
        set({ actionErrorKey: 'week.moveError' });
      }
    },

    async postpone(id, target) {
      try {
        await useCases.postpone([id], target);
        set({ actionErrorKey: null });
        return true;
      } catch {
        set({ actionErrorKey: 'tasks.postponeError' });
        return false;
      }
    },

    async postponeSeries(id, target, scope) {
      try {
        const result = await series.postpone(id, target, scope);
        set({ actionErrorKey: result.ok ? null : 'tasks.postponeError' });
        return result.ok;
      } catch {
        set({ actionErrorKey: 'tasks.postponeError' });
        return false;
      }
    },

    async sendToSomeday(id) {
      try {
        const moved = await useCases.moveToSomeday([id]);
        set({ actionErrorKey: moved.length > 0 ? null : 'someday.sendError' });
        return moved.length > 0;
      } catch {
        set({ actionErrorKey: 'someday.sendError' });
        return false;
      }
    },

    async remove(id, scope) {
      try {
        if (scope) {
          const result = await series.remove(id, scope);
          set({ actionErrorKey: result.ok ? null : 'tasks.deleteError' });
          return result.ok;
        }
        await useCases.remove([id]);
        set({ actionErrorKey: null });
        return true;
      } catch {
        set({ actionErrorKey: 'tasks.deleteError' });
        return false;
      }
    },

    async moveRow(rows, id, toIndex) {
      const outcome = moveTaskRow(rows, id, toIndex);
      if (!outcome) return null;
      if (outcome.changes.length === 0) return outcome;
      try {
        await useCases.reorder(outcome.changes.map((change) => ({ id: change.id as TaskId, sortOrder: change.sortOrder })));
        set({ actionErrorKey: null });
        return outcome;
      } catch {
        set({ actionErrorKey: 'today.reorderError' });
        return null;
      }
    },

    async toggleDone(id) {
      const current = container.taskEntities.get(id);
      if (!current) return false;
      try {
        // Le cas d'usage publie la tâche écrite (et l'occurrence suivante d'une série, T-09) dans la source unique.
        if (current.status === 'done') await useCases.reopen(id);
        else await useCases.complete(id);
        set({ actionErrorKey: null });
        return true;
      } catch {
        set({ actionErrorKey: 'tasks.completeError' });
        return false;
      }
    },

    async toggleRoutine(routineId, date) {
      const { weekStart, filter } = get();
      const entry = get().extras.get(date)?.routines?.find((candidate) => candidate.routine.id === routineId);
      const busyKey = `${routineId}|${date}`;
      if (weekStart === null || !entry || routinesBusy.has(busyKey)) return false;
      routinesBusy.add(busyKey);
      try {
        await toggleRoutineViaSources(container, routineId, date, !entry.done);
        // Toute la semaine est relue : valider peut atteindre le quota d'une routine « X fois par semaine » (QB-01) et la retirer des autres jours.
        const loaded = await Promise.all(weekDays(weekStart).map(async (day) => ({ day, ...(await loadTodayExtras(container, day, filter, 'week')) })));
        if (get().weekStart !== weekStart) return true;
        const extras = new Map<LocalDate, WeekDayExtras>();
        for (const { day, extras: dayExtras } of loaded) if (dayExtras !== EMPTY_TODAY_EXTRAS) extras.set(day, dayExtras);
        set({ extras, extrasFailed: loaded.some((day) => day.failed), actionErrorKey: null });
        return true;
      } catch {
        set({ actionErrorKey: 'tasks.completeError' });
        return false;
      } finally {
        routinesBusy.delete(busyKey);
      }
    },

    async refreshExtras() {
      const { weekStart, filter } = get();
      if (weekStart === null) return;
      try {
        const loaded = await Promise.all(weekDays(weekStart).map(async (day) => ({ day, ...(await loadTodayExtras(container, day, filter, 'week')) })));
        if (get().weekStart !== weekStart) return;
        const extras = new Map<LocalDate, WeekDayExtras>();
        for (const { day, extras: dayExtras } of loaded) if (dayExtras !== EMPTY_TODAY_EXTRAS) extras.set(day, dayExtras);
        // Agendas externes (K-03) : une actualisation ou un changement d'espace d'agenda met la grille à jour sans recharger la semaine.
        let external: { externalEvents: readonly ExternalEvent[]; calendarAccounts: readonly CalendarAccount[] } | null = null;
        try {
          const [externalEvents, calendarAccounts] = await Promise.all([container.data.repos.externalEvents.listBetween(externalEventRange(weekStart)), container.data.repos.calendarAccounts.listAll()]);
          external = { externalEvents, calendarAccounts };
        } catch {
          // Relecture discrète : l'affichage reste celui d'avant.
        }
        if (get().weekStart !== weekStart) return;
        set({ extras, ...(external ?? {}), extrasFailed: loaded.some((day) => day.failed) });
      } catch {
        set({ extrasFailed: true });
      }
    },

    async syncRecurrences(tasks) {
      const known = get().recurrences;
      const recurrences = await loadRecurrences(tasks, known);
      if (recurrences !== known) set({ recurrences });
    },
  }));
});
