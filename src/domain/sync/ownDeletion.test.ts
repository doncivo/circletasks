import { describe, expect, it } from 'vitest';
import { deletionStillListed, ownDeletionKey, parseOwnDeletionReceipts, type OwnDeletionReceipt } from './ownDeletion';
import type { EpochId } from './format';
import type { IsoDateTime } from '../types';
import { SyncStateUnreadableError } from './stored';

const EPOCH = 'e0001-56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as EpochId;
const row: OwnDeletionReceipt = { epoch: EPOCH, kind: 's', n: 1, orphan: false, accepted: true, failure: null };
const failure = { epoch: EPOCH, kind: 's' as const, orphan: false, code: 'io' as const, at: '2026-10-19T08:00:00.000Z' as IsoDateTime };

describe('preuves locales de suppression propre', () => {
  it('accepte les reçus normaux et les échecs, sans les réécrire', () => {
    const state = [row, { ...row, kind: 'epoch', n: undefined }, { ...row, failure }];
    expect(parseOwnDeletionReceipts(state)).toBe(state);
    expect(ownDeletionKey(row)).toBe(`${EPOCH}/s/1`);
    expect(ownDeletionKey({ epoch: EPOCH, kind: 'epoch' })).toBe(`${EPOCH}/epoch/0`);
  });

  it.each([null, {}, [null], ['bad'], [{ ...row, epoch: 'other' }], [{ ...row, kind: 'x' }], [{ ...row, n: 0 }], [{ ...row, orphan: null }], [{ ...row, accepted: null }], [{ ...row, failure: undefined }], [{ ...row, failure: { ...failure, code: 'unknown' } }], [{ ...row, failure: { ...failure, at: 'yesterday' } }], [{ ...row, failure: { ...failure, at: '2026-02-30T08:00:00.000Z' } }], [{ ...row, failure: { ...failure, epoch: 'other' } }], [{ ...row, failure: { ...failure, kind: 'j' } }], [{ ...row, failure: { ...failure, orphan: true } }]])('un suivi illisible ne devient jamais un suivi vide (%j)', (state) => {
    expect(() => parseOwnDeletionReceipts(state)).toThrow(SyncStateUnreadableError);
  });

  it('reconnaît seulement la référence demandée dans le listing courant', () => {
    const epochs = [{ epoch: EPOCH, segments: [2], snapshots: [1] }];
    expect(deletionStillListed(row, epochs)).toBe(true);
    expect(deletionStillListed({ ...row, n: 2 }, epochs)).toBe(false);
    expect(deletionStillListed({ ...row, kind: 'j', n: 2 }, epochs)).toBe(true);
    expect(deletionStillListed({ ...row, kind: 'j', n: 1 }, epochs)).toBe(false);
    expect(deletionStillListed({ ...row, kind: 'epoch' }, epochs)).toBe(true);
    expect(deletionStillListed(row, [])).toBe(false);
  });
});
