import { duplicateGroups, type DuplicateGroup, type OccurrenceRow } from '../../domain/occurrenceDedup';
import type { TaskId } from '../../domain/types';
import type { Repositories } from '../../db/repositories';
import { logFailure } from '../../platform/desktop/log';
import type { TaskUseCaseDeps } from './taskUseCases';

/**
 * T-TECH-01 (B8, décisions D7 et D8) : nettoyage des occurrences dédoublées avant les identifiants déterministes. Module chargé à la
 * demande (bundle de départ, PRD 8), lancé par `startup.ts` au premier cycle de synchro conclu avec succès après la mise à jour.
 *
 * Technique (spike de la fiche, critère 14) : un passage JavaScript avec les vrais hlc, jamais une migration SQL. Une migration ne peut pas
 * poser de hlc : ses écritures ne se propagent pas, donc chaque appareil écarterait des lignes de son côté seulement et deux appareils
 * aux données différentes divergeraient (voir « Preuves » de docs/stories/T-TECH-01.md).
 *
 * Deux appareils aux données différentes (une complétion pas encore lue par l'un) écartent des lignes différentes, mais les deux
 * suppressions sont de vraies écritures : après synchronisation les bases sont identiques, sans survivante pour ce groupe. Le démarrage
 * suivant rétablit alors la ligne terminée écartée par erreur (`heal`) ; jusque-là elle est dans la Corbeille et dans les conflits.
 */

/** Clé de `sync_meta` (locale) : état du passage de cet appareil ; absente tant que le passage n'a pas eu lieu. */
export const RECURRENCE_DEDUP_META = 'recurrenceDedup';

/** Écarts à vérifier au démarrage suivant : lignes qui étaient « à faire » ici quand elles ont été écartées. */
interface DedupState {
  readonly heal: readonly TaskId[];
}

export interface RecurrenceDedupResult {
  readonly groups: number;
  readonly removed: number;
  readonly restored: number;
}

export interface RecurrenceDedupDeps extends Pick<TaskUseCaseDeps, 'data' | 'taskEntities'> {
  /** Journal technique (nombres seulement, jamais un titre) ; défaut : le journal persistant de l'app. */
  readonly log?: (message: string) => void;
}

function parseState(raw: string): DedupState {
  try {
    const value = JSON.parse(raw) as { heal?: unknown };
    return { heal: Array.isArray(value.heal) ? value.heal.filter((id): id is TaskId => typeof id === 'string') : [] };
  } catch {
    return { heal: [] };
  }
}

/** Écarte (corbeille de 30 jours, rappels compris) les lignes perdantes de chaque groupe ; rend les identifiants écartés. */
async function discard(repos: Repositories, groups: readonly DuplicateGroup[]): Promise<TaskId[]> {
  const ids = groups.flatMap((group) => group.discarded);
  if (ids.length === 0) return [];
  for (const task of await repos.tasks.softDelete(ids)) {
    await repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, task.deletedAt ?? undefined);
  }
  return ids;
}

/** Rétablit une ligne terminée écartée ici quand elle était « à faire » et dont le groupe n'a plus aucune ligne vivante. */
async function heal(repos: Repositories, ids: readonly TaskId[]): Promise<TaskId[]> {
  const restored: TaskId[] = [];
  for (const id of ids) {
    const row = await repos.tasks.getById(id, { includeDeleted: true });
    if (!row || row.deletedAt === null || row.status !== 'done' || row.recurrenceId === null) continue;
    const series = await repos.tasks.listByRecurrence(row.recurrenceId);
    if (series.some((t) => t.seriesIndex === row.seriesIndex)) continue;
    await repos.tasks.restore([id]);
    restored.push(id);
  }
  return restored;
}

/**
 * Un seul passage de nettoyage par appareil, puis une seule vérification au démarrage suivant (`RECURRENCE_DEDUP_META`, posé dans la
 * même transaction que les écarts). Les écarts sont de vraies écritures (hlc de l'appareil, entrées d'envoi), donc publiées aux autres
 * appareils. Rend null s'il n'y a plus rien à faire.
 */
export async function runRecurrenceDedupOnce(deps: RecurrenceDedupDeps): Promise<RecurrenceDedupResult | null> {
  const outcome = await deps.data.transaction(async (repos) => {
    const raw = await repos.sync.getMeta(RECURRENCE_DEDUP_META);
    if (raw !== null) {
      const state = parseState(raw);
      if (state.heal.length === 0) return null;
      const restored = await heal(repos, state.heal);
      await repos.sync.setMeta(RECURRENCE_DEDUP_META, JSON.stringify({ heal: [] }));
      return { groups: 0, removed: [] as TaskId[], restored };
    }
    const rows: OccurrenceRow[] = await (await repos.occurrenceDedup()).listLiveDuplicates();
    const groups = duplicateGroups(rows);
    const removed = await discard(repos, groups);
    const todo = new Set(rows.filter((r) => !r.done).map((r) => r.id));
    await repos.sync.setMeta(RECURRENCE_DEDUP_META, JSON.stringify({ heal: removed.filter((id) => todo.has(id)) }));
    return { groups: groups.length, removed, restored: [] as TaskId[] };
  });
  if (!outcome) return null;
  deps.taskEntities.remove(outcome.removed);
  const result = { groups: outcome.groups, removed: outcome.removed.length, restored: outcome.restored.length };
  // D8 : aucune écriture silencieuse ; nombres seulement.
  if (result.removed + result.restored > 0) (deps.log ?? ((message) => logFailure('recurrence', message)))(`recurrence-dedup ${JSON.stringify(result)}`);
  if (outcome.restored.length > 0) deps.taskEntities.publish(await deps.data.repos.tasks.listByIds(outcome.restored));
  return result;
}
