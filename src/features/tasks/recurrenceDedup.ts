import { DEDUP_FAILURES_META, duplicateGroups, groupKey, reconcileGroup, type GroupRow } from '../../domain/occurrenceDedup';
import type { Hlc, IsoDateTime, RecurrenceId, TaskId } from '../../domain/types';
import type { Repositories } from '../../db/repositories';
import { logFailure } from '../../platform/desktop/log';
import type { TaskUseCaseDeps } from './taskUseCases';

/**
 * T-TECH-01 (B8, décisions D7 et D8) : nettoyage des occurrences dédoublées (versions d'avant les identifiants déterministes, ou
 * appareils restés en version antérieure). Module chargé à la demande (bundle de départ, PRD 8), lancé par `startup.ts` après chaque
 * cycle de synchro réussi.
 *
 * Technique (spike de la fiche, critère 14) : un passage JavaScript avec les vrais hlc, jamais une migration SQL. Une migration ne peut pas
 * poser de hlc : ses écritures ne se propagent pas, donc chaque appareil écarterait des lignes de son côté seulement et deux appareils
 * aux données différentes divergeraient (voir « Preuves » de docs/stories/T-TECH-01.md).
 *
 * Deux appareils aux données différentes (une modification ou une complétion pas encore lue par l'un) peuvent écarter chacun la ligne que
 * l'autre garde : les bases convergent, mais sans survivante, ou avec la terminée à la Corbeille. Le passage garde donc les clés des
 * groupes qu'il a nettoyés (`sync_meta`) et, après chaque cycle réussi, applique `reconcileGroup` à chacune (règle déterministe : les deux
 * appareils font la même écriture) ; une clé n'est retirée qu'une fois son groupe stable. Il est réexécutable : un doublon créé ensuite par
 * un appareil resté en version antérieure est repris au cycle suivant.
 */

/** Clé de `sync_meta` (locale) : clés `recurrence_id|series_index` des groupes nettoyés, encore suivis. */
export const RECURRENCE_DEDUP_META = 'recurrenceDedup';

export interface RecurrenceDedupResult {
  readonly groups: number;
  readonly removed: number;
  readonly restored: number;
}

export interface RecurrenceDedupDeps extends Pick<TaskUseCaseDeps, 'data' | 'taskEntities'> {
  /** Journal technique (nombres seulement, jamais un titre) ; défaut : le journal persistant de l'app. */
  readonly log?: (message: string) => void;
}

/** Clés suivies ; un état illisible (écrit par une autre version) est journalisé, jamais avalé, et repart de zéro. */
function parseKeys(raw: string | null, log: (message: string) => void): string[] {
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw) as { groups?: unknown };
    return Array.isArray(value.groups) ? value.groups.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    log('recurrence-dedup-state-unreadable {"code":"parse"}');
    return [];
  }
}

/** Écarte (corbeille de 30 jours, rappels compris) ces lignes vivantes. */
async function discard(repos: Repositories, ids: readonly TaskId[]): Promise<void> {
  if (ids.length === 0) return;
  for (const task of await repos.tasks.softDelete(ids)) {
    await repos.reminders.softDeleteForTarget({ type: 'task', id: task.id }, task.deletedAt ?? undefined);
  }
}

/** Rétablit une ligne à la corbeille avec les rappels supprimés en même temps qu'elle. */
async function restore(repos: Repositories, id: TaskId, deletedAt: IsoDateTime | null): Promise<void> {
  await repos.tasks.restore([id]);
  if (deletedAt !== null) await repos.reminders.restoreForTarget({ type: 'task', id }, { deletedAt, hlc: '' as Hlc });
}

/**
 * Un passage : suit les groupes déjà nettoyés (`reconcileGroup`), puis écarte les doublons vivants (survivant D7). Une seule transaction ;
 * les écarts sont de vraies écritures (hlc de l'appareil, entrées d'envoi), donc publiées aux autres appareils.
 */
export async function runRecurrenceDedup(deps: RecurrenceDedupDeps): Promise<RecurrenceDedupResult> {
  // Compte rendu normal (pas un échec) : scope « sync-… », classé dans la catégorie Synchro de l'écran Logs et non parmi les Erreurs (M5).
  const log = deps.log ?? ((message: string) => logFailure('sync-recurrence', message));
  const outcome = await deps.data.transaction(async (repos) => {
    const raw = await repos.sync.getMeta(RECURRENCE_DEDUP_META);
    const removed: TaskId[] = [];
    const restored: TaskId[] = [];
    const tracked = new Set<string>();
    for (const key of parseKeys(raw, log)) {
      const cut = key.lastIndexOf('|');
      const seriesIndex = Number(key.slice(cut + 1));
      const tasks = (await repos.tasks.listByRecurrence(key.slice(0, cut) as RecurrenceId, { includeDeleted: true })).filter((t) => t.seriesIndex === seriesIndex);
      const rows: GroupRow[] = tasks.map((t) => ({ id: t.id, recurrenceId: t.recurrenceId as RecurrenceId, seriesIndex, done: t.status === 'done', hlc: t.hlc, live: t.deletedAt === null }));
      const plan = reconcileGroup(rows);
      if (plan.restore === null && plan.discard.length === 0) continue; // groupe stable : plus suivi
      tracked.add(key);
      await discard(repos, plan.discard);
      removed.push(...plan.discard);
      if (plan.restore !== null) {
        await restore(repos, plan.restore, tasks.find((t) => t.id === plan.restore)?.deletedAt ?? null);
        restored.push(plan.restore);
      }
    }
    const groups = duplicateGroups(await (await repos.occurrenceDedup()).listLiveDuplicates());
    for (const group of groups) {
      await discard(repos, group.discarded);
      removed.push(...group.discarded);
      tracked.add(groupKey(group.recurrenceId, group.seriesIndex));
    }
    const next = JSON.stringify({ groups: [...tracked].sort() });
    if (next !== (raw ?? JSON.stringify({ groups: [] }))) await repos.sync.setMeta(RECURRENCE_DEDUP_META, next);
    return { groups: groups.length, removed, restored };
  });
  deps.taskEntities.remove(outcome.removed);
  const result = { groups: outcome.groups, removed: outcome.removed.length, restored: outcome.restored.length };
  // D8 : aucune écriture silencieuse ; nombres seulement.
  if (result.removed + result.restored > 0) log(`recurrence-dedup ${JSON.stringify(result)}`);
  if (outcome.restored.length > 0) deps.taskEntities.publish(await deps.data.repos.tasks.listByIds(outcome.restored));
  return result;
}

/**
 * Passage compté (I4) : un échec est journalisé, compté dans `sync_meta` (`DEDUP_FAILURES_META`) puis relancé à l'appelant ; un passage réussi
 * remet le compteur à zéro. Au seuil, une ligne des Détails de la synchro le dit (`SyncDetailsDedup`).
 */
export async function runRecurrenceDedupCounted(deps: RecurrenceDedupDeps): Promise<RecurrenceDedupResult> {
  const sync = deps.data.repos.sync;
  try {
    const result = await runRecurrenceDedup(deps);
    if ((await sync.getMeta(DEDUP_FAILURES_META)) !== null) await sync.setMeta(DEDUP_FAILURES_META, null);
    return result;
  } catch (error) {
    try {
      await sync.setMeta(DEDUP_FAILURES_META, String(Number((await sync.getMeta(DEDUP_FAILURES_META)) ?? 0) + 1));
    } catch (counterError) {
      logFailure('recurrence', counterError);
    }
    throw error;
  }
}
