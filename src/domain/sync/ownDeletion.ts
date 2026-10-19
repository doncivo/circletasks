import { isEpochId, isFileNumber, isSyncErrorCode, type EpochId, type SyncErrorCode } from './format';
import { SyncStateUnreadableError } from './stored';
import type { IsoDateTime } from '../types';

export interface OwnDeleteFailure {
  readonly epoch: EpochId;
  readonly kind: 'epoch' | 'j' | 's';
  readonly orphan: boolean;
  readonly code: SyncErrorCode;
  readonly at: IsoDateTime;
}

/** Preuve locale de la demande ; conservée même après une absence pour reconnaître un retour iCloud tardif. */
export interface OwnDeletionReceipt {
  readonly epoch: EpochId;
  readonly kind: 'epoch' | 'j' | 's';
  readonly n?: number;
  readonly orphan: boolean;
  readonly accepted: boolean;
  readonly failure: OwnDeleteFailure | null;
}

export function parseOwnDeletionReceipts(value: unknown): OwnDeletionReceipt[] {
  const invalid = () => { throw new SyncStateUnreadableError('own-deletion.receipts'); };
  if (!Array.isArray(value)) return invalid();
  for (const row of value as unknown[]) {
    if (!row || typeof row !== 'object') return invalid();
    const r = row as Partial<OwnDeletionReceipt>;
    if (!isEpochId(r.epoch) || !['epoch', 'j', 's'].includes(r.kind ?? '') || (r.kind !== 'epoch' && !isFileNumber(r.n)) || typeof r.orphan !== 'boolean' || typeof r.accepted !== 'boolean') return invalid();
    if (r.failure !== null) {
      const f = r.failure;
      if (!f || f.epoch !== r.epoch || f.kind !== r.kind || f.orphan !== r.orphan || !isSyncErrorCode(f.code) || typeof f.at !== 'string' || !Number.isFinite(Date.parse(f.at)) || new Date(f.at).toISOString() !== f.at) return invalid();
    }
  }
  return value as OwnDeletionReceipt[];
}

export const ownDeletionKey = (row: Pick<OwnDeletionReceipt, 'epoch' | 'kind' | 'n'>): string => `${row.epoch}/${row.kind}/${String(row.n ?? 0)}`;

export function deletionStillListed(row: OwnDeletionReceipt, epochs: readonly { readonly epoch: EpochId; readonly segments: readonly number[]; readonly snapshots: readonly number[] }[]): boolean {
  const epoch = epochs.find((e) => e.epoch === row.epoch);
  return epoch !== undefined && (row.kind === 'epoch' || (row.kind === 'j' ? epoch.segments : epoch.snapshots).includes(row.n as number));
}
