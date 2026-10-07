import type { Repositories, SyncStateRow } from '../db/repositories';
import { compareVersions, newerKind } from '../domain/sync/compat';
import { deviceStateOf } from '../domain/sync/devices';
import { SYNC_FORMAT_MAJOR } from '../domain/sync/format';
import { hlcIso } from '../domain/sync/parse';
import { parseStoredSegmentGaps, type StoredStateLog } from '../domain/sync/stored';
import type { DeviceId, IsoDateTime } from '../domain/types';
import type { SyncDeviceStatus } from '../platform/sync/types';
import { defaultSyncLogger } from './log';
import { META } from './meta';

/**
 * Appareils affichés (APPAREILS) d'après `sync_state` : une seule règle pour le moteur (fin de cycle) et les bandeaux A-09 (avant le
 * premier cycle, `startSync.ts`) (revue A-09, point 5). Retenus : soi, les appareils dont un état a été accepté (ce cycle ou avant).
 *
 * Y-07 critère 11 : `newer` = `'major'` pour une majeure supérieure (statut `newer-major`, lecture suspendue), `'schema'` pour un `sv`
 * supérieur de même majeure (`compat.ts`), sinon null ; `appVersion` = numéro d'application publié, null quand il n'est plus à jour.
 * Sans `localSv` (bandeaux) : champs de version absents.
 */
export function storedDeviceStatuses(
  rows: readonly SyncStateRow[],
  options: { readonly self?: DeviceId; readonly accepted?: ReadonlySet<DeviceId>; readonly localSv?: number; readonly gaps?: ReadonlyMap<DeviceId, { readonly since: IsoDateTime }> },
): SyncDeviceStatus[] {
  const { self, accepted, localSv, gaps } = options;
  return rows
    .filter((row) => row.isSelf || accepted?.has(row.deviceId as DeviceId) === true || row.stateSeq > 0)
    .map((row): SyncDeviceStatus => {
      const isSelf = self === undefined ? row.isSelf : row.deviceId === self;
      const status = deviceStateOf(row.status);
      // Cinquième revue, point 7 : trou impossible à combler (`sync_meta.segmentGaps`) : texte distinct.
      const gap = isSelf ? undefined : gaps?.get(row.deviceId as DeviceId);
      const base = {
        ...(gap ? { gapSince: gap.since } : {}),
        deviceId: row.deviceId as DeviceId,
        platform: row.platform === 'ios' ? ('ios' as const) : ('windows' as const),
        self: isSelf,
        lastReadAt: isSelf ? row.lastSyncAt : row.ackHlc ? hlcIso(row.ackHlc) : null,
        status,
      };
      if (isSelf || localSv === undefined) return base;
      const relation = compareVersions({ sm: SYNC_FORMAT_MAJOR, sv: localSv }, { sm: row.formatMajor, sv: row.schemaVersion });
      const stale = status === 'newer-major' && relation !== 'newer-major';
      // Champs Y-07 pour les autres appareils seulement (soi : sans objet).
      return { ...base, appVersion: stale ? null : row.appVersion, newer: status === 'newer-major' ? 'major' : newerKind(relation) };
    })
    .sort((a, b) => (a.self === b.self ? (a.deviceId < b.deviceId ? -1 : 1) : a.self ? -1 : 1));
}

/**
 * Sixième revue, point 6 : appareils affichés d'après les états persistés (`sync_state` et trous `sync_meta.segmentGaps`, texte distinct),
 * pour l'interface avant le premier cycle (`startSync.ts`), sans qu'elle lise ni analyse `sync_meta`. Valeur illisible :
 * `SyncStateUnreadableError` journalisée (l'appelant signale `state-unreadable`), jamais lue comme « aucun trou ».
 */
export async function readStoredDeviceStatuses(repos: Repositories, log: StoredStateLog = defaultSyncLogger): Promise<SyncDeviceStatus[]> {
  const gaps = parseStoredSegmentGaps(await repos.sync.getMeta(META.segmentGaps), `sync_meta.${META.segmentGaps}`, log);
  return storedDeviceStatuses(await repos.sync.getStates(), { gaps });
}
