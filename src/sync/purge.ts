import type { Repositories } from '../db/repositories';
import { childRelations, syncTable, type SyncTable } from '../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../domain/types';
import type { SyncLogger } from './log';

/**
 * Purge physique avec traces (ADR 0011, section 5.4 ; Y-09 critères 2, 6 et 11), commune à la purge locale, aux traces d'un instantané
 * et au report d'époque. À appeler **dans une transaction gardée** : lignes, rappels qui les visent, traces et cache des comptes partent
 * ensemble ou pas du tout.
 *
 * - Une ligne qui a encore une ligne enfant (clés du catalogue) n'est jamais purgée ni tracée : elle est écartée et journalisée (la
 *   purger casserait la clé étrangère, et la reprise échouerait à chaque cycle).
 * - Les rappels d'une tâche, d'une routine ou d'un événement purgés sont purgés et tracés avec eux (T-08 : un rappel ne survit pas à sa cible).
 */

export interface PurgeItem {
  readonly id: string;
  readonly deletedHlc: Hlc;
}

const REMINDER_TARGETS: ReadonlySet<string> = new Set(['task', 'routine', 'event']);

const maxHlc = (a: Hlc, b: Hlc | undefined): Hlc => (b !== undefined && b > a ? b : a);

/** Purge `items` de la table `t` ; renvoie les lignes effectivement purgées et les rappels purgés avec elles. */
export async function purgeRows(
  repos: Repositories,
  t: SyncTable,
  items: readonly PurgeItem[],
  purgedAt: IsoDateTime,
  logger: SyncLogger,
  options: { readonly reattach?: (table: string, ids: readonly string[]) => void } = {},
): Promise<{ readonly purged: PurgeItem[]; readonly reminders: string[] }> {
  const reminderIds: string[] = [];
  if (items.length === 0) return { purged: [], reminders: reminderIds };
  if (options.reattach && t.name === 'project') {
    // Décision (c) : trace de purge d'un projet reçue (instantané, report d'époque) ; les tâches vivantes encore dessous passent à
    // « Sans projet » du même espace et repartent entières (`'+'`) : rien n'est perdu, les appareils convergent.
    for (const rel of childRelations(t.name)) {
      const moved = await repos.sync.detachLiveChildren(
        rel.table,
        rel.column,
        items.map((item) => item.id),
      );
      if (moved.length > 0) {
        logger.log('children-reattached', { table: rel.table.name, parent: t.name, count: moved.length });
        options.reattach(rel.table.name, moved);
      }
    }
  }
  const blocked = await repos.sync.withChildren(
    t,
    items.map((item) => item.id),
  );
  if (blocked.size > 0) logger.log('purge-skipped', { table: t.name, reason: 'live-children', count: blocked.size });
  const kept = items.filter((item) => !blocked.has(item.id));
  if (kept.length === 0) return { purged: [], reminders: reminderIds };
  const ids = kept.map((item) => item.id);
  const reminderTable = syncTable('reminder');
  if (REMINDER_TARGETS.has(t.name) && reminderTable) {
    const reminders = await repos.sync.targetReminders(t.name, ids);
    if (reminders.length > 0) {
      const deletedOf = new Map(kept.map((item) => [item.id, item.deletedHlc]));
      await repos.sync.insertTombstones(
        reminders.map((r) => ({ table: 'reminder', rowId: r.id, deletedHlc: maxHlc(r.hlc, deletedOf.get(r.targetId)) })),
        purgedAt,
      );
      reminderIds.push(...reminders.map((r) => r.id));
      await repos.sync.deleteRows(reminderTable, reminderIds);
    }
  }
  if (t.name === 'calendar_account') await repos.sync.deleteExternalEventsOf(ids);
  await repos.sync.insertTombstones(
    kept.map((item) => ({ table: t.name, rowId: item.id, deletedHlc: item.deletedHlc })),
    purgedAt,
  );
  await repos.sync.deleteRows(t, ids);
  return { purged: kept, reminders: reminderIds };
}
