/**
 * Synchronisation par journaux chiffrés dans iCloud Drive (ADR 0011 ; ordre 4, lot Y2).
 * Couche autorisée à dépendre de domain, db et platform ; jamais de features ni d'ui. Les règles pures sont dans `src/domain/sync`.
 */
export { createSyncService, type SyncEngineService, type SyncServiceOptions } from './service';
export { startSyncScheduler, SYNC_POLL_MS, type SyncScheduler, type SyncSchedulerEnv } from './scheduler';
export { syncAge, phaseOf, INITIAL_STATUS, type SyncAge } from './status';
export { storedDeviceStatuses } from './deviceStatus';
export { currentPurgeHorizon, purgeDeleted as purgeDeletedRows } from './maintenance';
export type { RestoreContext } from './restoreChoice';
export { readForgetStatus } from './forget';
export { readResetStatus } from './reset';
export { defaultSyncLogger, silentSyncLogger, createMemorySyncLogger, type SyncLogger } from './log';
export { JOIN_META } from './join';
