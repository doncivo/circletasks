import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isDeviceAck, type DeviceAck, type ForgottenDevice } from '../../../../src/domain/sync/format';
import {
  activeReaders,
  canPurgeDeletion,
  completedForgotten,
  coversForgotten,
  cutoff,
  eligibleSnapshot,
  forgetGaps,
  snapshotInEpoch,
  declarationAuthor,
  declarationHlc,
  forgetOrder,
  forgottenDeleteCheck,
  learnDeclarations,
  purgeHorizon,
  readByAll,
  seenDevices,
  type ForgetKnownDevice,
  type ForgetStateStatus,
  type KnownDevice,
} from '../../../../src/domain/sync/retention';
import { PAIRING_CLOCK_TOLERANCE_MS } from '../../../../src/domain/sync/limits';
import type { DeviceId, Hlc, IsoDateTime } from '../../../../src/domain/types';
import table from '../../../fixtures/sync/forget-order.json';
import { snapshotEndJson, snapshotReadOf } from './snapshotJson';

/**
 * Y-10 critères 7, 8, 10, 11 et 12 (ADR 0011 §14.2, §18) : ordre total des oublis, coupure au maximum des accusés, conditions de
 * suppression des fichiers d'un appareil oublié. La table `forget-order.json` est lue aussi par `forget.rs` (même résultat des deux côtés).
 * Aucune attente réelle : les âges (30 jours, 180 jours) se règlent par l'horloge passée en paramètre.
 */

type JsonAcks = Readonly<Record<string, DeviceAck>>;
const toAcks = (acks: JsonAcks): Map<DeviceId, DeviceAck> => new Map(Object.entries(acks).map(([id, ack]) => [id as DeviceId, ack]));

describe('table de cas commune Rust / Vitest (forget-order.json)', () => {
  it('la table contient des cas pour les trois fonctions, accusés valides', () => {
    expect(table.forgetOrder.length).toBeGreaterThanOrEqual(10);
    expect(table.cutoff.length).toBeGreaterThanOrEqual(5);
    expect(table.forgottenDelete.length).toBeGreaterThanOrEqual(20);
    expect(table.learn.length).toBeGreaterThanOrEqual(5);
    expect(table.declarationHlc.length).toBeGreaterThanOrEqual(6);
    expect(table.seen.length).toBeGreaterThanOrEqual(6);
    for (const c of table.cutoff) {
      for (const a of c.ackers) for (const ack of Object.values(a.acks)) expect(isDeviceAck(ack)).toBe(true);
      if (c.expected !== null) expect(isDeviceAck(c.expected)).toBe(true);
    }
  });

  for (const c of table.forgetOrder) {
    it(`forgetOrder : ${c.name}`, () => {
      const result = forgetOrder(c.entries as unknown as ForgottenDevice[]);
      expect(Object.fromEntries(result)).toEqual(c.expected);
    });
  }

  for (const c of table.learn) {
    it(`learnDeclarations : ${c.name}`, () => {
      expect(learnDeclarations(c.master as unknown as ForgottenDevice[], c.candidates as unknown as ForgottenDevice[])).toEqual(c.expected);
    });
  }

  for (const c of table.seen) {
    it(`seenDevices (même définition que Rust, seconde revue point 4) : ${c.name}`, () => {
      const states = c.states.map((s) => ({ deviceId: s.deviceId as DeviceId, acks: toAcks(s.acks as unknown as JsonAcks) }));
      expect([...seenDevices(c.accepted as DeviceId[], states, c.master as unknown as ForgottenDevice[])].sort()).toEqual(c.expected);
    });
  }

  for (const c of table.declarationHlc) {
    it(`declarationHlc : ${c.name}`, () => {
      expect(declarationHlc(c.nowMs, c.seen, c.self as DeviceId, PAIRING_CLOCK_TOLERANCE_MS)).toEqual(c.expected);
    });
  }

  for (const c of table.cutoff) {
    it(`cutoff : ${c.name}`, () => {
      const ackers = c.ackers.map((a) => ({ deviceId: a.deviceId as DeviceId, acks: toAcks(a.acks as JsonAcks) }));
      expect(cutoff(c.target as DeviceId, ackers)).toEqual(c.expected);
    });
  }

  for (const c of table.writeStateForgotten) {
    it(`completedForgotten (sync_write_state) : ${c.name}`, () => {
      expect(completedForgotten(c.published as unknown as ForgottenDevice[], c.master as unknown as ForgottenDevice[])).toEqual(c.expected);
    });
  }

  for (const c of table.forgottenDelete) {
    it(`forgottenDeleteCheck : ${c.name}`, () => {
      const known: ForgetKnownDevice[] = c.known.map((d) => ({
        deviceId: d.deviceId as DeviceId,
        status: d.status as ForgetStateStatus,
        seen: d.seen,
        state: d.state
          ? { deviceId: d.deviceId as DeviceId, stateSeq: d.state.stateSeq, acks: toAcks(d.state.acks as JsonAcks), forgotten: d.state.forgotten as unknown as ForgottenDevice[] }
          : null,
      }));
      expect(forgottenDeleteCheck(c.target as DeviceId, c.self as DeviceId, c.master as unknown as ForgottenDevice[], c.done as DeviceId[], known, snapshotReadOf(c.ownSnapshot))).toEqual(c.expected);
    });
  }

  const ackersOf = (list: readonly { deviceId: string; acks: unknown }[]): { deviceId: DeviceId; acks: Map<DeviceId, DeviceAck> }[] =>
    list.map((a) => ({ deviceId: a.deviceId as DeviceId, acks: toAcks(a.acks as JsonAcks) }));

  for (const c of table.coversForgotten) {
    it(`coversForgotten (§18 point 11) : ${c.name}`, () => {
      expect(coversForgotten(toAcks(c.covers as unknown as JsonAcks), c.master as unknown as ForgottenDevice[], ackersOf(c.ackers))).toEqual(c.expected);
    });
  }

  for (const c of table.eligible) {
    it(`eligibleSnapshot (§18 point 11) : ${c.name}`, () => {
      const candidates = c.candidates.map((x) => ({
        state: x.state as never,
        end: snapshotReadOf(x.end),
        ...('ok' in x ? { ok: x.ok as boolean } : {}),
      }));
      const result = eligibleSnapshot(candidates, c.master as unknown as ForgottenDevice[], ackersOf(c.ackers), c.epoch as never);
      const shown = result.kind === 'ok' ? { kind: 'ok', author: result.end.author, seq: result.end.seq } : result;
      expect(shown).toEqual(c.expected);
      if (result.kind === 'ok') expect(snapshotEndJson(result.end)).toEqual(c.candidates.find((x) => typeof x.end !== 'string' && x.end.author === result.end.author)?.end);
    });
  }

  for (const c of table.ownSnapshotEpoch) {
    it(`snapshotInEpoch (condition (h), troisième revue) : ${c.name}`, () => {
      const result = snapshotInEpoch(snapshotReadOf(c.read), c.epoch as never);
      expect(typeof result === 'string' ? result : snapshotEndJson(result)).toEqual(c.expected);
    });
  }

  for (const c of table.gaps) {
    it(`forgetGaps (§18 point 11) : ${c.name}`, () => {
      expect(forgetGaps(c.master as unknown as ForgottenDevice[], ackersOf(c.ackers), toAcks(c.cursors as unknown as JsonAcks), new Set(c.gone as DeviceId[]))).toEqual(c.expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Propriétés (critère 7) : ordre de lecture et doublons indifférents ; jamais deux appareils qui s'oublient l'un l'autre.
// ---------------------------------------------------------------------------------------------------------------------------------

const DEVICES = [
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
] as DeviceId[];
const hlcOf = (n: number, dev: DeviceId, counter = 0): Hlc => `${String(1_791_000_000_000 + n).padStart(15, '0')}-${counter.toString(16).padStart(4, '0')}-${dev}` as Hlc;

/** Déclaration (auteur = appareil du hlc) ; parfois mal formée (hlc non strict) pour vérifier qu'elle est toujours ignorée. */
const declArb: fc.Arbitrary<ForgottenDevice> = fc
  .record({ by: fc.constantFrom(...DEVICES), target: fc.constantFrom(...DEVICES), n: fc.integer({ min: 0, max: 40 }), counter: fc.integer({ min: 0, max: 3 }), broken: fc.integer({ min: 0, max: 9 }) })
  .map(({ by, target, n, counter, broken }) => ({ deviceId: target, at: (broken === 0 ? `x${hlcOf(n, by, counter).slice(1)}` : hlcOf(n, by, counter)) as Hlc, lastAck: null }));

describe('ordre total : propriétés (fast-check, aucun délai)', () => {
  it('le résultat ne dépend ni de l’ordre de lecture ni des déclarations lues deux fois', () => {
    const withPermutation = fc
      .array(declArb, { maxLength: 24 })
      .chain((decls) => {
        const doubled = [...decls, ...decls.slice(0, 6)];
        return fc.tuple(fc.constant(decls), fc.shuffledSubarray(doubled, { minLength: doubled.length }));
      });
    fc.assert(
      fc.property(withPermutation, ([decls, permuted]) => {
        expect(Object.fromEntries(forgetOrder(permuted))).toEqual(Object.fromEntries(forgetOrder(decls)));
      }),
    );
  });

  it('un appareil oublié n’a oublié personne après son propre oubli ; deux appareils ne s’oublient jamais l’un l’autre', () => {
    fc.assert(
      fc.property(fc.array(declArb, { maxLength: 24 }), (decls) => {
        const result = forgetOrder(decls);
        for (const [target, verdict] of result) {
          expect(verdict.by).not.toBe(target);
          const authorForgotten = result.get(verdict.by);
          // L'auteur peut être oublié, mais seulement par une déclaration postérieure.
          if (authorForgotten) expect(authorForgotten.at > verdict.at || (authorForgotten.at === verdict.at && authorForgotten.by > verdict.by)).toBe(true);
          expect(authorForgotten?.by).not.toBe(target);
        }
      }),
    );
  });

  it('chaque oubli retenu correspond à une déclaration lue, bien formée, dont l’auteur est l’appareil de son hlc', () => {
    fc.assert(
      fc.property(fc.array(declArb, { maxLength: 24 }), (decls) => {
        for (const [target, verdict] of forgetOrder(decls)) {
          expect(decls.some((d) => d.deviceId === target && d.at === verdict.at && declarationAuthor(d) === verdict.by)).toBe(true);
        }
      }),
    );
  });

  it('apprentissage : la liste maître ne fait que grandir, et après de nouvelles lectures (scans suivants) son ordre total est celui de toutes les déclarations lues, quel que soit l’ordre de lecture', () => {
    /** Scans successifs : chaque scan relit toutes les déclarations encore publiées, jusqu'à ce que la liste ne change plus. */
    const settleAll = (start: ForgottenDevice[], all: readonly ForgottenDevice[]): ForgottenDevice[] => {
      let master = start;
      for (let i = 0; i < 20; i += 1) {
        const next = learnDeclarations(master, all).entries;
        if (next.length === master.length) return next;
        master = next;
      }
      return master;
    };
    fc.assert(
      fc.property(fc.array(fc.array(declArb, { maxLength: 6 }), { maxLength: 5 }), (batches) => {
        let master: ForgottenDevice[] = [];
        for (const batch of batches) {
          const before = master;
          master = learnDeclarations(before, batch).entries;
          expect(master.slice(0, before.length)).toEqual(before);
        }
        const all = batches.flat();
        const forward = settleAll(master, all);
        const backward = settleAll([...batches].reverse().reduce<ForgottenDevice[]>((m, batch) => learnDeclarations(m, batch).entries, []), all);
        expect(Object.fromEntries(forgetOrder(forward))).toEqual(Object.fromEntries(forgetOrder(all)));
        expect(Object.fromEntries(forgetOrder(backward))).toEqual(Object.fromEntries(forgetOrder(all)));
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Coupure (critère 8) : maximum, croissante avec les accusés, indépendante de l'ordre des appareils.
// ---------------------------------------------------------------------------------------------------------------------------------

const X = DEVICES[3] as DeviceId;
const E1 = `e0001-${String(DEVICES[0])}` as DeviceAck['epoch'];
const ackArb: fc.Arbitrary<DeviceAck> = fc
  .record({ segment: fc.integer({ min: 0, max: 4 }), record: fc.integer({ min: 0, max: 4 }), n: fc.integer({ min: 0, max: 50 }), seq: fc.integer({ min: 0, max: 5 }) })
  .map(({ segment, record, n, seq }) => ({ epoch: E1, segment, record, hlc: hlcOf(n, X), stateSeq: seq }));

describe('coupure : propriétés', () => {
  it('le maximum ne dépend pas de l’ordre des appareils et domine chaque accusé ; un accusé de plus ne la fait jamais reculer', () => {
    fc.assert(
      fc.property(fc.array(fc.option(ackArb, { nil: undefined }), { minLength: 1, maxLength: 3 }), ackArb, (acks, extra) => {
        const ackers = acks.map((ack, i) => ({ deviceId: DEVICES[i] as DeviceId, acks: new Map(ack ? [[X, ack]] : []) }));
        const cut = cutoff(X, ackers);
        expect(cutoff(X, [...ackers].reverse())).toEqual(cut);
        for (const ack of acks) if (ack) expect(cut).not.toBeNull();
        for (const ack of acks) {
          if (!ack || !cut) continue;
          expect(ack.segment < cut.segment || (ack.segment === cut.segment && ack.record <= cut.record)).toBe(true);
        }
        const grown = cutoff(X, [...ackers, { deviceId: DEVICES[4] as DeviceId, acks: new Map([[X, extra]]) }]);
        if (cut && grown) expect(grown.segment > cut.segment || (grown.segment === cut.segment && grown.record >= cut.record)).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Effet sur la purge (critère 10) : un appareil oublié ne compte plus, sans attendre 180 jours (horloge passée en paramètre).
// ---------------------------------------------------------------------------------------------------------------------------------

describe('purge : l’appareil oublié ne compte plus dans les accusés', () => {
  const SELF = DEVICES[0] as DeviceId;
  const B = DEVICES[1] as DeviceId;
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-10-06T08:00:00.000Z');
  const h = (ms: number, dev: DeviceId): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
  const ackAt = (ms: number): DeviceAck => ({ epoch: E1, segment: 1, record: 1, hlc: h(ms, SELF), stateSeq: 1 });
  const deletedAt = (ms: number) => ({ deletedAt: new Date(ms).toISOString() as IsoDateTime, deletedHlc: h(ms, SELF) });
  const device = (deviceId: DeviceId, status: string, ackMs: number | null, lastSeenMs: number): KnownDevice => ({
    deviceId,
    status,
    lastSeenHlc: h(lastSeenMs, deviceId),
    acks: new Map(ackMs === null ? [] : [[SELF, ackAt(ackMs)]]),
  });

  it('X perdu (vu il y a 31 jours, n’a pas lu la suppression) bloque jusqu’à 180 jours ; oublié, la trace est purgée dès que B l’a lue et 30 jours après', () => {
    const del = deletedAt(NOW - 31 * DAY);
    const lost = device(X, 'active', NOW - 40 * DAY, NOW - 31 * DAY);
    const readerB = device(B, 'active', NOW - DAY, NOW);
    expect(canPurgeDeletion(del, purgeHorizon([lost, readerB], SELF, NOW), NOW)).toBe(false);
    // Sans oubli, il faut attendre que X soit `expired` (180 jours après sa dernière synchro).
    expect(canPurgeDeletion(del, purgeHorizon([lost, readerB], SELF, NOW + 150 * DAY), NOW + 150 * DAY)).toBe(true);
    expect(canPurgeDeletion(del, purgeHorizon([lost, readerB], SELF, NOW + 148 * DAY), NOW + 148 * DAY)).toBe(false);
    const forgotten = { ...lost, status: 'forgotten' };
    expect(activeReaders([forgotten, readerB], SELF, NOW).map((d) => d.deviceId)).toEqual([B]);
    expect(canPurgeDeletion(del, purgeHorizon([forgotten, readerB], SELF, NOW), NOW)).toBe(true);
    // Toujours 30 jours au moins après la suppression.
    expect(canPurgeDeletion(deletedAt(NOW - 29 * DAY), purgeHorizon([forgotten, readerB], SELF, NOW), NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Horizon de purge (§18 point 13) : terminé dont l'oubli est annulé, accusés figés d'un terminé.
// ---------------------------------------------------------------------------------------------------------------------------------

describe('horizon de purge et oublis (seconde revue, §18 points 12 et 13)', () => {
  const SELF = DEVICES[0] as DeviceId;
  const B = DEVICES[1] as DeviceId;
  const C = DEVICES[2] as DeviceId;
  const X = DEVICES[3] as DeviceId;
  const NOW_MS = 1_791_000_100_000;
  const ackOn = (dev: DeviceId, n: number): DeviceAck => ({ epoch: `e0001-${SELF}` as DeviceAck['epoch'], segment: 1, record: n, hlc: hlcOf(n, dev), stateSeq: 1 });
  const device = (deviceId: DeviceId, status: string, acks: [DeviceId, DeviceAck][]): KnownDevice => ({ deviceId, status, lastSeenHlc: hlcOf(90, deviceId), acks: new Map(acks) });

  it('terminé dont l’oubli est annulé : blocked, quels que soient les accusés', () => {
    const devices = [device(B, 'active', [[SELF, ackOn(SELF, 99)]])];
    expect(purgeHorizon(devices, SELF, NOW_MS).kind).toBe('limited');
    expect(purgeHorizon(devices, SELF, NOW_MS, [C]).kind).toBe('blocked');
  });

  it('accusés figés d’un terminé sans effet sur l’horizon : un oublié ne compte pas comme lecteur, ses accusés publiés par les actifs non plus', () => {
    const withFrozen = [device(B, 'active', [[SELF, ackOn(SELF, 5)], [X, ackOn(X, 3)]]), device(X, 'forgotten', [[SELF, ackOn(SELF, 1)]])];
    const without = [device(B, 'active', [[SELF, ackOn(SELF, 5)]])];
    const a = purgeHorizon(withFrozen, SELF, NOW_MS);
    const b = purgeHorizon(without, SELF, NOW_MS);
    expect(a.kind).toBe('limited');
    expect(a.kind === 'limited' ? a.readers.map((r) => r.deviceId) : []).toEqual([B]);
    expect(readByAll(hlcOf(4, SELF), a)).toBe(readByAll(hlcOf(4, SELF), b));
    expect(readByAll(hlcOf(6, SELF), a)).toBe(readByAll(hlcOf(6, SELF), b));
  });
});
