import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { epochId, type DeviceAck, type EpochId } from '../../../../src/domain/sync/format';
import { resetPrecondition, resetWaiting, resetWinner, restoreCandidates, validReset, type OpenedEpoch, type ResetCandidate, type ResetKnownDevice, type ResetPreconditionDevice } from '../../../../src/domain/sync/epoch';
import type { DeviceId, Hlc } from '../../../../src/domain/types';
import table from '../../../fixtures/sync/reset-order.json';

/**
 * Y-11 critères 3, 12, 13 et 15 (ADR 0011 §14.3, §18 point 2) : validité et gagnant des annonces de réinitialisation, précondition
 * « tout lu jusqu'à la tête », appareils pas encore réassociés. La table `reset-order.json` est lue aussi par `reset.rs` (mêmes
 * résultats des deux côtés).
 */

type JsonCandidate = { by: string; stateEpoch: string; notice: { kid: string; epoch: string; at: string }; restore?: boolean };
const candidateOf = (c: JsonCandidate): ResetCandidate => ({
  by: c.by as DeviceId,
  stateEpoch: c.stateEpoch as EpochId,
  notice: { kid: c.notice.kid, epoch: c.notice.epoch as EpochId, at: c.notice.at as Hlc },
  ...(c.restore ? { restore: true } : {}),
});

describe('table de cas commune Rust / Vitest (reset-order.json)', () => {
  it('validReset', () => {
    expect(table.validReset.length).toBeGreaterThanOrEqual(8);
    for (const c of table.validReset) expect(validReset(candidateOf(c.candidate)), c.name).toBe(c.expected);
  });

  it('resetWinner', () => {
    expect(table.resetWinner.length).toBeGreaterThanOrEqual(8);
    for (const c of table.resetWinner) {
      const winner = resetWinner(c.candidates.map(candidateOf), new Set(c.forgotten as DeviceId[]));
      expect(winner ? { by: winner.by, epoch: winner.notice.epoch } : null, c.name).toEqual(c.expected);
    }
  });

  it('resetPrecondition', () => {
    expect(table.resetPrecondition.length).toBeGreaterThanOrEqual(9);
    for (const c of table.resetPrecondition) {
      const actives = c.actives as unknown as ResetPreconditionDevice[];
      const forgotten = c.forgotten as unknown as { deviceId: DeviceId; cutoff: DeviceAck | null }[];
      const own = new Map(Object.entries(c.ownAcks as Record<string, DeviceAck>).map(([id, ack]) => [id as DeviceId, ack]));
      expect(resetPrecondition(actives, forgotten, own), c.name).toEqual(c.expected);
    }
  });

  it('resetWaiting', () => {
    expect(table.resetWaiting.length).toBeGreaterThanOrEqual(6);
    for (const c of table.resetWaiting) {
      expect(resetWaiting(c.known as unknown as ResetKnownDevice[], c.self as DeviceId, c.epoch as EpochId, c.kid, new Set(c.forgotten as DeviceId[])), c.name).toEqual(c.expected);
    }
  });

  it('restoreCandidates (§18 point 16 : époques restaurées sous K qui concourent avec les annonces)', () => {
    expect(table.restoreCandidates.length).toBeGreaterThanOrEqual(2);
    for (const c of table.restoreCandidates) {
      const got = restoreCandidates(c.states as unknown as OpenedEpoch[], (c.announcements as JsonCandidate[]).map(candidateOf));
      expect(got, c.name).toEqual((c.expected as JsonCandidate[]).map(candidateOf));
    }
  });
});

describe('propriétés du gagnant (même vue sur chaque appareil)', () => {
  const ids = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'] as DeviceId[];
  const candidate = fc.record({ by: fc.constantFrom(...ids), n: fc.integer({ min: 2, max: 4 }), kid: fc.stringMatching(/^[0-9a-f]{16}$/), ms: fc.integer({ min: 1, max: 999_999 }) }).map(
    ({ by, n, kid, ms }): ResetCandidate => ({ by, stateEpoch: epochId(n - 1, ids[0] as DeviceId), notice: { kid: kid.toLowerCase(), epoch: epochId(n, by), at: `${String(ms).padStart(15, '0')}-0000-${by}` as Hlc } }),
  );

  it('le gagnant ne dépend pas de l’ordre de lecture des annonces (ni du kid ni du hlc)', () => {
    fc.assert(
      fc.property(fc.array(candidate, { maxLength: 6 }), fc.subarray(ids), (list, forgotten) => {
        // Une seule annonce par auteur (anti-rejeu) : la dernière lue.
        const byAuthor = [...new Map(list.map((c) => [c.by, c])).values()];
        const set = new Set(forgotten);
        const a = resetWinner(byAuthor, set);
        const b = resetWinner([...byAuthor].reverse(), set);
        expect(a?.notice.epoch ?? null).toBe(b?.notice.epoch ?? null);
        if (a) expect(set.has(a.by)).toBe(false);
      }),
    );
  });
});
