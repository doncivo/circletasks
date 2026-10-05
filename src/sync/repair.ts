import { focusSessionsToClose, routinePausedFrom } from '../domain/sync/repairs';
import { syncTable } from '../domain/sync/syncTables';
import type { SyncDeps } from './deps';

/**
 * Réparations après un lot appliqué (ADR 0011, section 8 ; Y-02 critère 8), hors garde : `routine.paused` recalculé depuis
 * `routine_pause` (colonne locale, aucune entrée de file) ; une seule session Focus ouverte (écriture locale publiée, valeur
 * déterministe). Règles : `src/domain/sync/repairs.ts`.
 */
export async function runRepairs(deps: SyncDeps, touched: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> {
  const repos = deps.data.repos;
  const routineIds = new Set<string>(touched.get('routine') ?? []);
  const pauseIds = [...(touched.get('routine_pause') ?? [])];
  const pauseTable = syncTable('routine_pause');
  if (pauseTable && pauseIds.length > 0) {
    for (const row of (await repos.sync.readRows(pauseTable, pauseIds)).values()) {
      const routineId = row.values.get('routine_id');
      if (typeof routineId === 'string') routineIds.add(routineId);
    }
  }
  if (routineIds.size > 0) {
    const pauses = await repos.sync.routinePauses([...routineIds]);
    for (const [routineId, periods] of pauses) await repos.sync.setRoutinePaused(routineId, routinePausedFrom(periods));
  }
  if (touched.has('focus_session')) {
    const toClose = focusSessionsToClose(await repos.sync.openFocusSessions());
    for (const { id, endedAt } of toClose) await repos.sync.closeFocusSession(id, endedAt);
  }
}
