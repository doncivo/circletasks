import type { ReintegrationFailure } from '../domain/sync/compat';
import type { DeviceId, IsoDateTime } from '../domain/types';
import { INITIAL_STATUS, type SyncDeviceStatus, type SyncErrorCode, type SyncForgetStatus, type SyncPhase, type SyncResetStatus, type SyncStatus } from '../platform/sync/types';

export { INITIAL_STATUS };

/**
 * Calcul de `SyncStatus` (ADR 0011, sections 10.4 et 11.2, avenant « Amorce » point 7 ; Y-02 critères 16 et 17, Y-05 critère 2,
 * Y-09 critère 10). Ce module ne fait que calculer : les types sont dans `src/platform/sync/types.ts`.
 */

/** Ce qu'un cycle a constaté. */
export interface CycleFacts {
  readonly outcome: 'not-configured' | 'needs-pairing' | 'restore-choice' | 'done' | 'failed' | 'forgotten' | 'restart-required' | 'reset-required';
  readonly errorCode: SyncErrorCode | null;
  readonly pendingFiles: readonly string[];
  readonly devices: readonly SyncDeviceStatus[];
  /** Aucun appareil connu ne partage la clé locale (tous `foreign`). */
  readonly keyMismatch: boolean;
}

/** Codes d'erreur qui signifient « en attente d'iCloud » plutôt qu'une erreur. */
const WAITING_CODES: ReadonlySet<string> = new Set(['cloud-pending']);

/** Phase affichée (priorité : configuration, choix de restauration, clé, erreur, version, horloge, iCloud, à jour). */
export function phaseOf(facts: CycleFacts): SyncPhase {
  switch (facts.outcome) {
    case 'not-configured':
      return 'not-configured';
    case 'needs-pairing':
      return 'needs-pairing';
    case 'restore-choice':
      return 'restore-choice';
    case 'forgotten':
    case 'restart-required':
      // Y-10 : `restart-required` : nouvelle identité posée par « Associer de nouveau », l'app doit être relancée (même écran).
      return 'forgotten';
    case 'reset-required':
      // Y-11 : annonce authentique d'une réinitialisation lancée ailleurs, ou perte de la sienne : à associer de nouveau.
      return 'reset-required';
    case 'failed':
      if (facts.errorCode === 'key-mismatch') return 'key-mismatch';
      return facts.errorCode !== null && WAITING_CODES.has(facts.errorCode) ? 'waiting-icloud' : 'error';
    case 'done':
      break;
  }
  if (facts.keyMismatch) return 'key-mismatch';
  if (facts.devices.some((d) => !d.self && d.status === 'newer-major')) return 'update-required';
  if (facts.devices.some((d) => !d.self && d.status === 'clock-ahead')) return 'clock-ahead';
  if (facts.pendingFiles.length > 0) return 'waiting-icloud';
  return 'idle';
}

export function statusFromFacts(
  previous: SyncStatus,
  facts: CycleFacts,
  extra: {
    readonly folderLabel: string | null;
    readonly folderKind?: SyncStatus['folderKind'];
    readonly lastSyncAt: IsoDateTime | null;
    readonly conflictsThisWeek: number;
    /** Y-07 (exigence d'Ali) : échec de réintégration lu dans `sync_meta` ; undefined : lecture impossible, valeur précédente gardée. */
    readonly reintegrationFailure?: ReintegrationFailure | null;
    /** Y-10 (exigence d'Ali) : échec d'oubli et suppressions en attente lus dans `sync_meta` ; undefined : lecture impossible, valeur gardée. */
    readonly forget?: SyncForgetStatus | null;
    /** Y-11 (exigence d'Ali) : réinitialisation lue dans `sync_meta.resetState` ; undefined : lecture impossible, valeur gardée. */
    readonly reset?: SyncResetStatus | null;
  },
): SyncStatus {
  const phase = phaseOf(facts);
  const clockAhead = facts.devices.find((d) => !d.self && d.status === 'clock-ahead');
  // Champ facultatif : absent quand il n'y a pas d'échec (les états sans échec restent identiques à ceux du lot Y2).
  const { reintegrationFailure: kept, forget: keptForget, reset: keptReset, ...rest } = previous;
  const failure = extra.reintegrationFailure === undefined ? (kept ?? null) : extra.reintegrationFailure;
  const forget = extra.forget === undefined ? (keptForget ?? null) : extra.forget;
  const reset = extra.reset === undefined ? (keptReset ?? null) : extra.reset;
  return {
    ...rest,
    ...(failure ? { reintegrationFailure: failure } : {}),
    ...(forget ? { forget } : {}),
    ...(reset ? { reset } : {}),
    phase,
    folderLabel: extra.folderLabel,
    folderKind: extra.folderKind ?? previous.folderKind ?? null,
    lastSyncAt: extra.lastSyncAt,
    devices: facts.devices.length > 0 || facts.outcome !== 'failed' ? facts.devices : previous.devices,
    pendingFiles: facts.pendingFiles,
    conflictsThisWeek: extra.conflictsThisWeek,
    progress: null,
    errorCode: facts.errorCode,
    clockAheadDevice: clockAhead ? (clockAhead.deviceId as DeviceId) : null,
  };
}

/** Âge de la dernière synchro (D2) : « à l'instant » sous 1 min, puis minutes, heures, jours. */
export type SyncAge = { readonly unit: 'now' } | { readonly unit: 'min' | 'h' | 'd'; readonly n: number };

export function syncAge(lastSyncAt: IsoDateTime, nowMs: number): SyncAge {
  const elapsed = Math.max(0, nowMs - Date.parse(lastSyncAt));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return { unit: 'now' };
  if (minutes < 60) return { unit: 'min', n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'h', n: hours };
  return { unit: 'd', n: Math.floor(hours / 24) };
}
