import type { Repositories, StoredConflict } from '../../db/repositories';
import { nowIso, todayLocal } from '../../domain/clock';
import { buildEventReminders } from '../../domain/eventReminders';
import { newEntityId } from '../../domain/id';
import type { NewReminder, Task } from '../../domain/model';
import { normalizeReminderOffsets, routineReminderFireAt } from '../../domain/routineReminder';
import { affectsReminders, conflictTarget, decideRestore, parentTableOf, type ConflictRowState, type RestoreDecision, type RestoreRefusal } from '../../domain/sync/conflictRestore';
import type { SyncValue } from '../../domain/sync/format';
import { hlcIso } from '../../domain/sync/parse';
import type { SyncColumn, SyncTable } from '../../domain/sync/syncTables';
import type { DeviceId, EventId, Hlc, IsoDateTime, ReminderId, RoutineId, TaskId } from '../../domain/types';
import { defaultSyncLogger, type SyncLogger } from '../../sync';
import type { AppContainer } from '../app/container';
import type { TaskEntities } from '../app/taskEntities';
import type { UndoableCommand, UndoOutcome } from '../app/undo';
import { emitEventsChanged } from '../events/eventEvents';
import { emitRoutinesChanged } from '../routines/routineEvents';
import { createNextOccurrence, UNDONE_OCCURRENCE_INDEX, type CreatedOccurrence } from '../tasks/recurrenceUseCases';
import { syncTaskReminders } from '../tasks/reminderSync';
import { createTrashUseCases } from '../tasks/trashUseCases';

export { conflictTarget, type RestoreRefusal } from '../../domain/sync/conflictRestore';

/**
 * Journal des conflits et restauration de la valeur écartée (Y-04 ; ADR 0011, sections 4.2, 4.3 et 5.4 ; decisions.md, Y-04 D1 à D3).
 * Les règles (cible du catalogue, refus, valeur déjà en place, conflit de suppression) sont dans `src/domain/sync/conflictRestore.ts` ;
 * ce module lit la base, applique la décision et pose l'annulation.
 *
 * - Liste : récents d'abord, 50 conflits **visibles** par page, 12 derniers mois ; seuls les champs `conflictVisible` du catalogue ;
 *   une ligne illisible est isolée et comptée (signalée à l'écran) ; titre lu au moment de l'affichage ; refus certain (ligne ou parent
 *   disparu, valeur invalide) recalculé à chaque lecture, affiché en permanence tant que l'état reste bloqué (exigence d'Ali).
 * - « Restaurer » (un clic) : **une seule transaction** : nouvelle écriture locale par le `WriteStamper` (les déclencheurs posent la
 *   base = horloge courante du champ et l'entrée de `sync_outbox`), échéances des rappels recalculées si la date ou l'heure change,
 *   `restored = 1`, `resolved_at`. État d'une tâche : par terminer / rouvrir (date de fin, occurrence suivante d'une série). Conflit
 *   « supprimé / modifié » : l'élément est restauré (tâche : cas d'usage de la corbeille T-08, rappels compris). Annulable 5 s
 *   (`syncRestore`) ; refusée (`'stale'`) si le champ a changé depuis.
 * - Sûreté (critère 9) : table et colonne cherchées dans le catalogue (jamais le texte de la ligne de journal dans une requête), colonnes
 *   `conflictVisible` seulement, valeur validée par `isValidValue` ; le journal technique ne reçoit que table, champ et issue.
 */

export const CONFLICTS_PAGE_SIZE = 50;
/** Conflits listés : 12 derniers mois (la purge est celle de Y-02). */
const LIST_WINDOW_MS = 365 * 86_400_000;

export type RestoreResult =
  | { readonly status: 'restored' }
  | { readonly status: 'already' }
  | { readonly status: 'refused'; readonly reason: RestoreRefusal }
  /** Erreur inattendue (base) : rien n'est écrit (transaction annulée). */
  | { readonly status: 'failed' };

export interface ConflictSideView {
  readonly value: SyncValue;
  readonly device: DeviceId;
  readonly hlc: Hlc;
  /** Instant de la valeur, tiré de son hlc. */
  readonly at: IsoDateTime;
  /** Titre de l'élément désigné par une valeur d'identifiant (projet, objectif…), s'il existe encore. */
  readonly ref: string | null;
}

export interface ConflictView {
  readonly id: number;
  readonly table: SyncTable;
  readonly column: SyncColumn;
  readonly rowId: string;
  /** Titre de l'élément (ou de son parent pour un jour de routine, la cible d'un rappel) ; null : pas de titre propre. */
  readonly title: string | null;
  readonly itemState: ConflictRowState;
  readonly kept: ConflictSideView;
  readonly discarded: ConflictSideView;
  readonly detectedAt: IsoDateTime;
  /** Date de la restauration (D2) ; null : pas encore restaurée. */
  readonly restoredAt: IsoDateTime | null;
  readonly restored: boolean;
  /** Refus certain d'une restauration, montré en permanence sur la ligne (null : restaurable). */
  readonly blocked: RestoreRefusal | null;
}

export interface ConflictPage {
  readonly items: readonly ConflictView[];
  readonly hasMore: boolean;
  /** Lignes du journal illisibles (contenu altéré) parmi celles parcourues : signalées, jamais affichées. */
  readonly unreadable: number;
}

export type SyncConflictDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo' | 'taskEntities'> & { readonly logger?: SyncLogger };

export interface SyncConflictUseCases {
  /** `pages` pages de 50 conflits ; rejette si la lecture échoue (l'écran l'affiche). */
  list(pages: number): Promise<ConflictPage>;
  /** Restaure la valeur écartée ; ne rejette jamais (échec : `failed`). */
  restore(conflictId: number): Promise<RestoreResult>;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Avis de changement (restauration, annulation) : l'écran relit le journal, où qu'ait eu lieu l'action (bandeau « Annuler », Ctrl+Z).
// ---------------------------------------------------------------------------------------------------------------------------------

/** Changement du journal : restauration tentée, ou annulation d'une restauration (le message de succès de la ligne n'a plus lieu d'être). */
export interface ConflictChange {
  readonly conflictId: number;
  readonly kind: 'restore' | 'undone';
}

const listeners = new WeakMap<object, Set<(change: ConflictChange) => void>>();

/** Écoute les changements du journal de ce conteneur (restauration, annulation). */
export function subscribeConflictChanges(owner: object, listener: (change: ConflictChange) => void): () => void {
  const set = listeners.get(owner) ?? new Set<(change: ConflictChange) => void>();
  set.add(listener);
  listeners.set(owner, set);
  return () => set.delete(listener);
}

function notifyConflictChanges(owner: object, change: ConflictChange): void {
  for (const listener of listeners.get(owner) ?? []) listener(change);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Lecture et application d'une décision
// ---------------------------------------------------------------------------------------------------------------------------------

/** Décision du domaine, avec ce qu'il faut pour l'appliquer et l'annuler. */
interface Plan {
  readonly decision: RestoreDecision;
  readonly previous: SyncValue;
  readonly previousHlc: Hlc | null;
}

/** Ce que ferait « Restaurer » maintenant (lecture seule : sert aussi au refus affiché en permanence). */
async function planRestore(repos: Repositories, table: SyncTable, column: SyncColumn, conflict: StoredConflict): Promise<Plan> {
  const current = await repos.syncConflicts.fieldState(table, column, conflict.rowId);
  const parentTable = parentTableOf(table, column);
  const parent = parentTable && typeof conflict.discardedValue === 'string' ? await repos.syncConflicts.rowState(parentTable, conflict.discardedValue) : null;
  return { decision: decideRestore({ column, discarded: conflict.discardedValue, row: current.row, current: current.value, parent }), previous: current.value, previousHlc: current.hlc };
}

const isReminderTarget = (table: SyncTable): table is SyncTable & { readonly name: 'task' | 'routine' | 'event' } => table.name === 'task' || table.name === 'routine' || table.name === 'event';

/** Ce qu'une restauration a changé hors de la base, à publier après le COMMIT. */
interface Outcome {
  readonly publish: Task[];
  readonly remove: TaskId[];
  routines: boolean;
  events: boolean;
}

const noOutcome = (): Outcome => ({ publish: [], remove: [], routines: false, events: false });

/** Collecteur : le cas d'usage de la corbeille publie dans la source unique ; on ne publie qu'après le COMMIT. */
function collectingEntities(real: TaskEntities, outcome: Outcome): TaskEntities {
  return { ...real, publish: (tasks) => void outcome.publish.push(...tasks), remove: (ids) => void outcome.remove.push(...ids) };
}

function publishOutcome(deps: SyncConflictDeps, outcome: Outcome): void {
  if (outcome.publish.length > 0) deps.taskEntities.publish(outcome.publish);
  if (outcome.remove.length > 0) deps.taskEntities.remove(outcome.remove);
  if (outcome.routines) emitRoutinesChanged(deps.data);
  if (outcome.events) emitEventsChanged(deps.data);
}

/** Met un élément dans l'état voulu (supprimé ou présent) par une écriture locale ; renvoie l'horloge du champ `deleted_at` après. */
async function setElementDeleted(
  deps: SyncConflictDeps,
  repos: Repositories,
  table: SyncTable,
  column: SyncColumn,
  rowId: string,
  deleted: { readonly at: SyncValue } | null,
  mark: { readonly deletedAt: SyncValue; readonly hlc: Hlc | null },
  outcome: Outcome,
): Promise<Hlc | null> {
  if (table.name === 'task') {
    const id = rowId as TaskId;
    if (deleted) {
      const [removed] = await repos.tasks.softDelete([id]);
      await repos.reminders.softDeleteForTarget({ type: 'task', id }, removed?.deletedAt ?? undefined);
      outcome.remove.push(id);
    } else {
      // Restauration par le cas d'usage de la corbeille (T-08, rappels compris), dans cette transaction.
      const scoped = { repos, transaction: <T,>(work: (r: Repositories) => Promise<T>) => work(repos) };
      const trash = createTrashUseCases({ ...deps, data: scoped, taskEntities: collectingEntities(deps.taskEntities, outcome) });
      const back = await trash.restore(id);
      if (!back) {
        // Hors de la fenêtre de 30 jours de la corbeille mais pas encore purgée (purge bloquée) : même restauration, sans ce filtre.
        const [restored] = await repos.tasks.restore([id]);
        if (typeof mark.deletedAt === 'string' && mark.hlc) await repos.reminders.restoreForTarget({ type: 'task', id }, { deletedAt: mark.deletedAt as IsoDateTime, hlc: mark.hlc });
        if (restored) outcome.publish.push(restored);
      }
    }
  } else {
    await repos.syncConflicts.writeField(table, column, rowId, deleted ? deleted.at : null);
    if (isReminderTarget(table)) {
      const target = { type: table.name, id: rowId } as Parameters<Repositories['reminders']['softDeleteForTarget']>[0];
      if (deleted) await repos.reminders.softDeleteForTarget(target, typeof deleted.at === 'string' ? (deleted.at as IsoDateTime) : undefined);
      else if (typeof mark.deletedAt === 'string' && mark.hlc) await repos.reminders.restoreForTarget(target, { deletedAt: mark.deletedAt as IsoDateTime, hlc: mark.hlc });
    }
    markChanged(table, outcome);
  }
  return (await repos.syncConflicts.fieldState(table, column, rowId)).hlc;
}

function markChanged(table: SyncTable, outcome: Outcome): void {
  if (table.name === 'routine' || table.name === 'routine_log' || table.name === 'routine_pause') outcome.routines = true;
  if (table.name === 'event') outcome.events = true;
}

/**
 * Échéances des rappels recalculées après un changement de date ou d'heure (N-02 critère 5), dans la transaction : tâche par
 * `syncTaskReminders` ; routine et événement comme leurs cas d'usage (mêmes avances, prochaine occurrence, nouvelles lignes).
 */
async function resyncReminders(deps: SyncConflictDeps, repos: Repositories, table: SyncTable, column: SyncColumn, rowId: string): Promise<void> {
  if (!affectsReminders(table, column)) return;
  if (table.name === 'task') {
    const task = await repos.tasks.getById(rowId as TaskId, { includeDeleted: true });
    if (task) await syncTaskReminders(repos, task);
    return;
  }
  if (table.name === 'routine') {
    const routine = await repos.routines.getById(rowId as RoutineId, { includeDeleted: true });
    const existing = await repos.reminders.listForTarget({ type: 'routine', id: rowId as RoutineId });
    // Sans heure (QB-07, N-02 critère 7) : rappels conservés tels quels mais inactifs (comme `routineUseCases.update`).
    if (!routine || routine.time === null || existing.length === 0) return;
    const from = todayLocal(deps.clock);
    const rows: NewReminder[] = [];
    for (const offsetMin of normalizeReminderOffsets(existing.map((r) => r.offsetMin), routine.time)) {
      const fireAt = routineReminderFireAt(routine, routine.time, from, offsetMin);
      if (fireAt !== null) rows.push({ id: newEntityId<ReminderId>(deps.ids), targetType: 'routine', targetId: routine.id, offsetMin, fireAt });
    }
    await repos.reminders.replaceForTarget({ type: 'routine', id: routine.id as RoutineId }, rows);
    return;
  }
  if (table.name === 'event') {
    const event = await repos.events.getById(rowId as EventId, { includeDeleted: true });
    const existing = await repos.reminders.listForTarget({ type: 'event', id: rowId as EventId });
    if (!event || existing.length === 0) return;
    const rows = buildEventReminders({ event, offsets: existing.map((r) => r.offsetMin), today: todayLocal(deps.clock), newReminderId: () => newEntityId<ReminderId>(deps.ids) });
    await repos.reminders.replaceForTarget({ type: 'event', id: event.id as EventId }, rows);
  }
}

/** Ce qu'une écriture de champ a fait de plus, pour l'annuler. */
interface Written {
  readonly after: Hlc | null;
  /** Occurrence suivante d'une série créée en terminant la tâche. */
  readonly next: CreatedOccurrence | null;
  /** Badge « reportée » effacé en terminant la tâche (T-06). */
  readonly wasCarriedOver: boolean;
}

/**
 * Écrit une valeur dans un champ. L'état d'une tâche passe par terminer / rouvrir du repository (date de fin écrite avec l'état, T-04 ;
 * occurrence suivante d'une série, T-09 ; badge « reportée » effacé, T-06) ; les autres champs par une écriture tamponnée. Échéances des
 * rappels recalculées ; tâche relue et republiée.
 */
async function writeValue(
  deps: SyncConflictDeps,
  repos: Repositories,
  table: SyncTable,
  column: SyncColumn,
  rowId: string,
  value: SyncValue,
  outcome: Outcome,
  restore: { readonly doneAt: SyncValue } = { doneAt: null },
): Promise<Written> {
  let next: CreatedOccurrence | null = null;
  let wasCarriedOver = false;
  if (table.name === 'task' && column.name === 'status') {
    const id = rowId as TaskId;
    if (value === 'done') {
      const doneAt = typeof restore.doneAt === 'string' ? (restore.doneAt as IsoDateTime) : nowIso(deps.clock);
      let done = await repos.tasks.complete(id, doneAt);
      wasCarriedOver = done.carriedOver;
      if (done.carriedOver) done = await repos.tasks.update(id, { carriedOver: false });
      // Annulation d'une restauration « à faire » : l'occurrence suivante existe déjà depuis la première fin.
      if (restore.doneAt === null && done.recurrenceId) next = await createNextOccurrence(deps, repos, done, todayLocal(deps.clock));
      if (next) outcome.publish.push(next.task);
    } else {
      await repos.tasks.reopen(id);
    }
  } else {
    await repos.syncConflicts.writeField(table, column, rowId, value);
  }
  await resyncReminders(deps, repos, table, column, rowId);
  await refreshTask(repos, table, rowId, outcome);
  markChanged(table, outcome);
  return { after: (await repos.syncConflicts.fieldState(table, column, rowId)).hlc, next, wasCarriedOver };
}

/** Tâche relue après une écriture de champ (titre, heure…) : republiée dans la source unique. */
async function refreshTask(repos: Repositories, table: SyncTable, rowId: string, outcome: Outcome): Promise<void> {
  if (table.name !== 'task') return;
  const task = await repos.tasks.getById(rowId as TaskId, { includeDeleted: true });
  if (!task) return;
  if (task.deletedAt === null) outcome.publish.push(task);
  else outcome.remove.push(task.id);
}

/** Retire l'occurrence suivante créée par la restauration de « terminée » (comme l'annulation de T-04). */
async function removeOccurrence(repos: Repositories, next: CreatedOccurrence, outcome: Outcome): Promise<void> {
  const created = await repos.tasks.getById(next.task.id as TaskId);
  if (!created) return;
  await repos.tasks.update(created.id, { seriesIndex: UNDONE_OCCURRENCE_INDEX });
  const [removed] = await repos.tasks.softDelete([created.id]);
  await repos.reminders.softDeleteForTarget({ type: 'task', id: created.id }, removed?.deletedAt ?? undefined);
  outcome.remove.push(created.id);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cas d'usage
// ---------------------------------------------------------------------------------------------------------------------------------

export function createSyncConflictUseCases(deps: SyncConflictDeps): SyncConflictUseCases {
  const logger = deps.logger ?? defaultSyncLogger;
  /** Journal technique : table et champ du catalogue, issue ; jamais une valeur ni un nom reçu (section 2.3). */
  const log = (target: { table: SyncTable; column: SyncColumn } | null, outcome: string): void =>
    logger.log('conflict-restore', { table: target?.table.name ?? 'unknown', field: target?.column.name ?? 'unknown', outcome });

  const undoCommand = (conflict: StoredConflict, table: SyncTable, column: SyncColumn, plan: Plan, written: Written, previousDoneAt: SyncValue): UndoableCommand => ({
    kind: 'syncRestore',
    count: 1,
    async undo(): Promise<UndoOutcome> {
      const outcome = noOutcome();
      const result = await deps.data.transaction(async (repos): Promise<UndoOutcome> => {
        const current = await repos.syncConflicts.fieldState(table, column, conflict.rowId);
        // Champ modifié depuis la restauration (autre action, synchro) : rien n'est écrasé.
        if (current.hlc === null || current.hlc !== written.after) return 'stale';
        if (plan.decision.kind === 'element') {
          await setElementDeleted(deps, repos, table, column, conflict.rowId, plan.decision.deleted ? null : { at: plan.previous }, { deletedAt: current.value, hlc: current.hlc }, outcome);
        } else {
          await writeValue(deps, repos, table, column, conflict.rowId, plan.previous, outcome, { doneAt: previousDoneAt });
          if (written.next) await removeOccurrence(repos, written.next, outcome);
          if (written.wasCarriedOver) await repos.tasks.update(conflict.rowId as TaskId, { carriedOver: true });
          await refreshTask(repos, table, conflict.rowId, outcome);
        }
        await repos.syncConflicts.markRestored(conflict.id, null);
        return 'undone';
      });
      if (result === 'undone') {
        publishOutcome(deps, outcome);
        log({ table, column }, 'undone');
        notifyConflictChanges(deps.data, { conflictId: conflict.id, kind: 'undone' });
      }
      return result;
    },
  });

  /** Conflits visibles du journal, jusqu'à `wanted` (page complétée après le filtre des champs visibles). */
  const visibleConflicts = async (since: IsoDateTime, wanted: number): Promise<{ shown: { conflict: StoredConflict; table: SyncTable; column: SyncColumn }[]; unreadable: number }> => {
    let fetch = wanted;
    for (;;) {
      const rows = await deps.data.repos.syncConflicts.listLog(since, fetch);
      const shown: { conflict: StoredConflict; table: SyncTable; column: SyncColumn }[] = [];
      let unreadable = 0;
      for (const row of rows) {
        if (!row.conflict) {
          unreadable += 1;
          continue;
        }
        const target = conflictTarget(row.conflict);
        if (target && shown.length < wanted) shown.push({ conflict: row.conflict, ...target });
      }
      if (shown.length >= wanted || rows.length < fetch) return { shown, unreadable };
      fetch *= 2;
    }
  };

  return {
    async list(pages) {
      const since = new Date(deps.clock.nowMs() - LIST_WINDOW_MS).toISOString() as IsoDateTime;
      const limit = Math.max(1, pages) * CONFLICTS_PAGE_SIZE;
      const { shown: found, unreadable } = await visibleConflicts(since, limit + 1);
      const hasMore = found.length > limit;
      const shown = found.slice(0, limit);
      const repos = deps.data.repos;
      const items = shown.map((s) => ({ table: s.table, rowId: s.conflict.rowId }));
      // Valeurs d'identifiant (projet, objectif…) : titre de l'élément désigné.
      const refs = shown.flatMap((s) => {
        const parent = parentTableOf(s.table, s.column);
        if (!parent) return [];
        return [s.conflict.keptValue, s.conflict.discardedValue].filter((v): v is string => typeof v === 'string').map((rowId) => ({ table: parent, rowId }));
      });
      const described = await repos.syncConflicts.describe([...items, ...refs]);
      const views: ConflictView[] = [];
      for (const { conflict, table, column } of shown) {
        const info = described.get(`${table.name}|${conflict.rowId}`) ?? { state: 'missing' as const, title: null };
        const parent = parentTableOf(table, column);
        const side = (value: SyncValue, device: string, hlc: Hlc): ConflictSideView => ({
          value,
          device: device as DeviceId,
          hlc,
          at: hlcIso(hlc),
          ref: parent && typeof value === 'string' ? (described.get(`${parent.name}|${value}`)?.title ?? null) : null,
        });
        let blocked: RestoreRefusal | null = null;
        if (!conflict.restored) {
          const plan = await planRestore(repos, table, column, conflict);
          blocked = plan.decision.kind === 'refused' ? plan.decision.reason : null;
        }
        views.push({
          id: conflict.id,
          table,
          column,
          rowId: conflict.rowId,
          title: info.title,
          itemState: info.state,
          kept: side(conflict.keptValue, conflict.keptDevice, conflict.keptHlc),
          discarded: side(conflict.discardedValue, conflict.discardedDevice, conflict.discardedHlc),
          detectedAt: conflict.detectedAt,
          restoredAt: conflict.restored ? conflict.resolvedAt : null,
          restored: conflict.restored,
          blocked,
        });
      }
      return { items: views, hasMore, unreadable };
    },

    async restore(conflictId) {
      let target: { table: SyncTable; column: SyncColumn } | null = null;
      try {
        const outcome = noOutcome();
        const result = await deps.data.transaction(async (repos): Promise<{ result: RestoreResult; command: UndoableCommand | null }> => {
          const conflict = await repos.syncConflicts.getConflict(conflictId);
          if (!conflict) return { result: { status: 'refused', reason: 'row-gone' }, command: null };
          if (conflict === 'unreadable') return { result: { status: 'refused', reason: 'invalid' }, command: null };
          target = conflictTarget(conflict);
          if (!target) return { result: { status: 'refused', reason: 'invalid' }, command: null };
          const { table, column } = target;
          if (conflict.restored) return { result: { status: 'already' }, command: null };
          const plan = await planRestore(repos, table, column, conflict);
          const now = nowIso(deps.clock);
          switch (plan.decision.kind) {
            case 'refused':
              return { result: { status: 'refused', reason: plan.decision.reason }, command: null };
            case 'already':
              // L'autre appareil a déjà restauré (ou la valeur est revenue) : aucune écriture, conflit résolu (critère 10).
              await repos.syncConflicts.markRestored(conflict.id, now);
              return { result: { status: 'already' }, command: null };
            case 'write': {
              // Date de fin d'une tâche terminée, remise par l'annulation d'une restauration « à faire ».
              const doneAt = table.name === 'task' && column.name === 'status' ? ((await repos.tasks.getById(conflict.rowId as TaskId, { includeDeleted: true }))?.doneAt ?? null) : null;
              const written = await writeValue(deps, repos, table, column, conflict.rowId, conflict.discardedValue, outcome);
              await repos.syncConflicts.markRestored(conflict.id, now);
              return { result: { status: 'restored' }, command: undoCommand(conflict, table, column, plan, written, doneAt) };
            }
            case 'element': {
              const deleted = plan.decision.deleted ? { at: conflict.discardedValue } : null;
              const after = await setElementDeleted(deps, repos, table, column, conflict.rowId, deleted, { deletedAt: plan.previous, hlc: plan.previousHlc }, outcome);
              await repos.syncConflicts.markRestored(conflict.id, now);
              return { result: { status: 'restored' }, command: undoCommand(conflict, table, column, plan, { after, next: null, wasCarriedOver: false }, null) };
            }
          }
        });
        publishOutcome(deps, outcome);
        if (result.command) deps.undo.push(result.command);
        log(target, result.result.status === 'refused' ? result.result.reason : result.result.status);
        notifyConflictChanges(deps.data, { conflictId, kind: 'restore' });
        return result.result;
      } catch (error) {
        log(target, 'failed');
        logger.log('conflict-restore-error', { name: error instanceof Error ? error.name : 'unknown' });
        return { status: 'failed' };
      }
    },
  };
}
