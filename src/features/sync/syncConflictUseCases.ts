import type { ConflictRowState, Repositories, StoredConflict } from '../../db/repositories';
import type { SyncValue } from '../../domain/sync/format';
import { MODIFIED_MARKER, sameValue } from '../../domain/sync/merge';
import { hlcIso } from '../../domain/sync/parse';
import { isValidValue, syncColumn, syncTable, type SyncColumn, type SyncTable } from '../../domain/sync/syncTables';
import type { Task } from '../../domain/model';
import type { DeviceId, Hlc, IsoDateTime, TaskId } from '../../domain/types';
import { defaultSyncLogger, type SyncLogger } from '../../sync';
import type { AppContainer } from '../app/container';
import type { TaskEntities } from '../app/taskEntities';
import type { UndoableCommand, UndoOutcome } from '../app/undo';
import { createTrashUseCases } from '../tasks/trashUseCases';

/**
 * Journal des conflits et restauration de la valeur écartée (Y-04 ; ADR 0011, sections 4.2, 4.3 et 5.4 ; decisions.md, Y-04 D1 à D3).
 *
 * - Liste : récents d'abord, 50 par page, 12 derniers mois ; seuls les champs `conflictVisible` du catalogue ; titre lu au moment de
 *   l'affichage ; refus prévisible (ligne ou parent disparu, valeur invalide) calculé à la lecture, pour l'afficher **en permanence**
 *   sur la ligne tant que l'état reste bloqué (exigence d'Ali : aucun échec silencieux).
 * - « Restaurer » (un clic, aucune confirmation) : **une seule transaction** : nouvelle écriture locale par le `WriteStamper` (les
 *   déclencheurs posent la base = horloge courante du champ et l'entrée de `sync_outbox`), `restored = 1`, `resolved_at`. Conflit
 *   « supprimé / modifié » : l'élément est restauré (tâche : cas d'usage de la corbeille T-08, rappels compris). Annulable 5 s
 *   (`syncRestore`) ; refusée (`'stale'`) si le champ a changé depuis.
 * - Sûreté (critère 9) : table et colonne cherchées dans le catalogue (jamais le texte de la ligne de journal dans une requête), colonnes
 *   `conflictVisible` seulement, valeur validée par `isValidValue` ; le journal technique ne reçoit que table, champ et issue.
 */

export const CONFLICTS_PAGE_SIZE = 50;
/** Conflits listés : 12 derniers mois (la purge est celle de Y-02). */
const LIST_WINDOW_MS = 365 * 86_400_000;

export type RestoreRefusal = 'row-gone' | 'parent-gone' | 'invalid';

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

const listeners = new WeakMap<object, Set<() => void>>();

/** Écoute les changements du journal de ce conteneur (restauration, annulation). */
export function subscribeConflictChanges(owner: object, listener: () => void): () => void {
  const set = listeners.get(owner) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(owner, set);
  return () => set.delete(listener);
}

function notifyConflictChanges(owner: object): void {
  for (const listener of listeners.get(owner) ?? []) listener();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Règles
// ---------------------------------------------------------------------------------------------------------------------------------

/** Table et colonne du catalogue désignées par une ligne de journal ; null si hors catalogue ou champ masqué (critères 2 et 9). */
export function conflictTarget(conflict: Pick<StoredConflict, 'table' | 'field'>): { readonly table: SyncTable; readonly column: SyncColumn } | null {
  const table = syncTable(conflict.table);
  const column = table ? syncColumn(table.name, conflict.field) : undefined;
  if (!table || !column || !column.conflictVisible) return null;
  return { table, column };
}

/** Conflit « supprimé / modifié » ou suppression contre restauration : champ `deleted_at`. */
const isDeletion = (column: SyncColumn): boolean => column.name === 'deleted_at';

/** État voulu par la valeur écartée d'un conflit de suppression : supprimé (vrai), présent (faux) ; null si la valeur est invalide. */
function wantsDeleted(column: SyncColumn, discarded: SyncValue): boolean | null {
  if (discarded === null || discarded === MODIFIED_MARKER) return false;
  return isValidValue(column, discarded) ? true : null;
}

/** Parent désigné par une colonne (clé étrangère du catalogue). */
const parentTableOf = (table: SyncTable, column: SyncColumn): SyncTable | undefined => {
  const relation = table.parents.find((p) => p.column === column.name);
  return relation ? syncTable(relation.table) : undefined;
};

type Plan =
  | { readonly kind: 'refused'; readonly reason: RestoreRefusal }
  | { readonly kind: 'already' }
  | { readonly kind: 'write'; readonly previous: SyncValue }
  | { readonly kind: 'element'; readonly deleted: boolean; readonly previous: SyncValue; readonly previousHlc: Hlc | null };

/** Ce que ferait « Restaurer » maintenant (lecture seule : sert aussi au refus affiché en permanence). */
async function planRestore(repos: Repositories, table: SyncTable, column: SyncColumn, conflict: StoredConflict): Promise<Plan> {
  const current = await repos.syncConflicts.fieldState(table, column, conflict.rowId);
  if (current.row === 'purged' || current.row === 'missing') return { kind: 'refused', reason: 'row-gone' };
  if (isDeletion(column)) {
    const wanted = wantsDeleted(column, conflict.discardedValue);
    if (wanted === null) return { kind: 'refused', reason: 'invalid' };
    if ((current.value !== null) === wanted) return { kind: 'already' };
    return { kind: 'element', deleted: wanted, previous: current.value, previousHlc: current.hlc };
  }
  if (!isValidValue(column, conflict.discardedValue)) return { kind: 'refused', reason: 'invalid' };
  const parent = parentTableOf(table, column);
  if (parent && typeof conflict.discardedValue === 'string' && (await repos.syncConflicts.rowState(parent, conflict.discardedValue)) !== 'live') {
    return { kind: 'refused', reason: 'parent-gone' };
  }
  if (sameValue(current.value, conflict.discardedValue)) return { kind: 'already' };
  return { kind: 'write', previous: current.value };
}

const isReminderTarget = (table: SyncTable): table is SyncTable & { readonly name: 'task' | 'routine' | 'event' } => table.name === 'task' || table.name === 'routine' || table.name === 'event';

/** Tâches modifiées par une restauration, à republier dans la source unique après la transaction. */
interface TaskOutcome {
  readonly publish: Task[];
  readonly remove: TaskId[];
}

const noTasks = (): TaskOutcome => ({ publish: [], remove: [] });

/** Collecteur : le cas d'usage de la corbeille publie dans la source unique ; on ne publie qu'après le COMMIT. */
function collectingEntities(real: TaskEntities, outcome: TaskOutcome): TaskEntities {
  return { ...real, publish: (tasks) => void outcome.publish.push(...tasks), remove: (ids) => void outcome.remove.push(...ids) };
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
  tasks: TaskOutcome,
): Promise<Hlc | null> {
  if (table.name === 'task') {
    const id = rowId as TaskId;
    if (deleted) {
      const [removed] = await repos.tasks.softDelete([id]);
      await repos.reminders.softDeleteForTarget({ type: 'task', id }, removed?.deletedAt ?? undefined);
      tasks.remove.push(id);
    } else {
      // Restauration par le cas d'usage de la corbeille (T-08, rappels compris), dans cette transaction.
      const scoped = { repos, transaction: <T,>(work: (r: Repositories) => Promise<T>) => work(repos) };
      const trash = createTrashUseCases({ ...deps, data: scoped, taskEntities: collectingEntities(deps.taskEntities, tasks) });
      const back = await trash.restore(id);
      if (!back) {
        // Hors de la fenêtre de 30 jours de la corbeille mais pas encore purgée (purge bloquée) : même restauration, sans ce filtre.
        const [restored] = await repos.tasks.restore([id]);
        if (typeof mark.deletedAt === 'string' && mark.hlc) await repos.reminders.restoreForTarget({ type: 'task', id }, { deletedAt: mark.deletedAt as IsoDateTime, hlc: mark.hlc });
        if (restored) tasks.publish.push(restored);
      }
    }
  } else {
    await repos.syncConflicts.writeField(table, column, rowId, deleted ? deleted.at : null);
    if (isReminderTarget(table)) {
      const target = { type: table.name, id: rowId } as Parameters<Repositories['reminders']['softDeleteForTarget']>[0];
      if (deleted) await repos.reminders.softDeleteForTarget(target, typeof deleted.at === 'string' ? (deleted.at as IsoDateTime) : undefined);
      else if (typeof mark.deletedAt === 'string' && mark.hlc) await repos.reminders.restoreForTarget(target, { deletedAt: mark.deletedAt as IsoDateTime, hlc: mark.hlc });
    }
  }
  return (await repos.syncConflicts.fieldState(table, column, rowId)).hlc;
}

/** Tâche relue après une écriture de champ (titre, heure…) : republiée dans la source unique. */
async function refreshTask(repos: Repositories, table: SyncTable, rowId: string, tasks: TaskOutcome): Promise<void> {
  if (table.name !== 'task') return;
  const task = await repos.tasks.getById(rowId as TaskId, { includeDeleted: true });
  if (!task) return;
  if (task.deletedAt === null) tasks.publish.push(task);
  else tasks.remove.push(task.id);
}

function publishTasks(entities: TaskEntities, tasks: TaskOutcome): void {
  if (tasks.publish.length > 0) entities.publish(tasks.publish);
  if (tasks.remove.length > 0) entities.remove(tasks.remove);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cas d'usage
// ---------------------------------------------------------------------------------------------------------------------------------

export function createSyncConflictUseCases(deps: SyncConflictDeps): SyncConflictUseCases {
  const logger = deps.logger ?? defaultSyncLogger;
  /** Journal technique : table et champ du catalogue, issue ; jamais une valeur ni un nom reçu (section 2.3). */
  const log = (target: { table: SyncTable; column: SyncColumn } | null, outcome: string): void =>
    logger.log('conflict-restore', { table: target?.table.name ?? 'unknown', field: target?.column.name ?? 'unknown', outcome });

  const undoCommand = (conflict: StoredConflict, table: SyncTable, column: SyncColumn, plan: Plan & { kind: 'write' | 'element' }, after: Hlc | null): UndoableCommand => ({
    kind: 'syncRestore',
    count: 1,
    async undo(): Promise<UndoOutcome> {
      const tasks = noTasks();
      const outcome = await deps.data.transaction(async (repos): Promise<UndoOutcome> => {
        const current = await repos.syncConflicts.fieldState(table, column, conflict.rowId);
        // Champ modifié depuis la restauration (autre action, synchro) : rien n'est écrasé.
        if (current.hlc === null || current.hlc !== after) return 'stale';
        if (plan.kind === 'write') {
          await repos.syncConflicts.writeField(table, column, conflict.rowId, plan.previous);
          await refreshTask(repos, table, conflict.rowId, tasks);
        } else {
          await setElementDeleted(deps, repos, table, column, conflict.rowId, plan.deleted ? null : { at: plan.previous }, { deletedAt: current.value, hlc: current.hlc }, tasks);
        }
        await repos.syncConflicts.markRestored(conflict.id, null);
        return 'undone';
      });
      if (outcome === 'undone') {
        publishTasks(deps.taskEntities, tasks);
        log({ table, column }, 'undone');
        notifyConflictChanges(deps.data);
      }
      return outcome;
    },
  });

  return {
    async list(pages) {
      const since = new Date(deps.clock.nowMs() - LIST_WINDOW_MS).toISOString() as IsoDateTime;
      const limit = Math.max(1, pages) * CONFLICTS_PAGE_SIZE;
      const rows = await deps.data.repos.sync.listConflicts(since, limit + 1);
      const hasMore = rows.length > limit;
      const shown: { conflict: StoredConflict; table: SyncTable; column: SyncColumn }[] = [];
      for (const conflict of rows.slice(0, limit)) {
        const target = conflictTarget(conflict);
        if (target) shown.push({ conflict, ...target });
      }
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
          blocked = plan.kind === 'refused' ? plan.reason : null;
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
      return { items: views, hasMore };
    },

    async restore(conflictId) {
      let target: { table: SyncTable; column: SyncColumn } | null = null;
      try {
        const tasks = noTasks();
        const result = await deps.data.transaction(async (repos): Promise<{ result: RestoreResult; command: UndoableCommand | null }> => {
          const conflict = await repos.syncConflicts.getConflict(conflictId);
          if (!conflict) return { result: { status: 'refused', reason: 'row-gone' }, command: null };
          target = conflictTarget(conflict);
          if (!target) return { result: { status: 'refused', reason: 'invalid' }, command: null };
          const { table, column } = target;
          if (conflict.restored) return { result: { status: 'already' }, command: null };
          const plan = await planRestore(repos, table, column, conflict);
          const now = new Date(deps.clock.nowMs()).toISOString() as IsoDateTime;
          switch (plan.kind) {
            case 'refused':
              return { result: { status: 'refused', reason: plan.reason }, command: null };
            case 'already':
              // L'autre appareil a déjà restauré (ou la valeur est revenue) : aucune écriture, conflit résolu (critère 10).
              await repos.syncConflicts.markRestored(conflict.id, now);
              return { result: { status: 'already' }, command: null };
            case 'write': {
              const after = await repos.syncConflicts.writeField(table, column, conflict.rowId, conflict.discardedValue);
              await refreshTask(repos, table, conflict.rowId, tasks);
              await repos.syncConflicts.markRestored(conflict.id, now);
              return { result: { status: 'restored' }, command: undoCommand(conflict, table, column, plan, after) };
            }
            case 'element': {
              const deleted = plan.deleted ? { at: conflict.discardedValue } : null;
              const after = await setElementDeleted(deps, repos, table, column, conflict.rowId, deleted, { deletedAt: plan.previous, hlc: plan.previousHlc }, tasks);
              await repos.syncConflicts.markRestored(conflict.id, now);
              return { result: { status: 'restored' }, command: undoCommand(conflict, table, column, plan, after) };
            }
          }
        });
        publishTasks(deps.taskEntities, tasks);
        if (result.command) deps.undo.push(result.command);
        log(target, result.result.status === 'refused' ? result.result.reason : result.result.status);
        notifyConflictChanges(deps.data);
        return result.result;
      } catch (error) {
        log(target, 'failed');
        logger.log('conflict-restore-error', { name: error instanceof Error ? error.name : 'unknown' });
        return { status: 'failed' };
      }
    },
  };
}
