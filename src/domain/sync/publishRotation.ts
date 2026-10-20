import { isEpochId, isFileNumber, isStrictHlc, isSyncErrorCode, type EpochId, type SyncErrorCode } from './format';
import type { Hlc } from '../types';
import { SyncStateUnreadableError } from './stored';

export interface PublishRotation {
  readonly epoch: EpochId;
  readonly segment: number;
  readonly code: SyncErrorCode;
  readonly maxHlc: Hlc;
}

/** Intention locale de rotation : jamais publiée et jamais remplacée par un état vide si elle est illisible. */
export function parsePublishRotation(raw: string | null): PublishRotation | null {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new SyncStateUnreadableError('publish-rotation'); }
  if (value && typeof value === 'object') {
    const row = value as Partial<PublishRotation>;
    if (isEpochId(row.epoch) && isFileNumber(row.segment) && isSyncErrorCode(row.code) && isStrictHlc(row.maxHlc)) return row as PublishRotation;
  }
  throw new SyncStateUnreadableError('publish-rotation');
}
