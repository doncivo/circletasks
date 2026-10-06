import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isDeviceAck, type DeviceAck, type ForgottenDevice } from '../../../../src/domain/sync/format';
import {
  activeReaders,
  canPurgeDeletion,
  cutoff,
  forgetOrder,
  forgottenDeleteCheck,
  purgeHorizon,
  type ForgetDeclaration,
  type ForgetKnownDevice,
  type ForgetStateStatus,
  type KnownDevice,
} from '../../../../src/domain/sync/retention';
import type { DeviceId, Hlc, IsoDateTime } from '../../../../src/domain/types';
import table from '../../../fixtures/sync/forget-order.json';

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
    expect(table.forgottenDelete.length).toBeGreaterThanOrEqual(10);
    for (const c of table.cutoff) {
      for (const a of c.ackers) for (const ack of Object.values(a.acks)) expect(isDeviceAck(ack)).toBe(true);
      if (c.expected !== null) expect(isDeviceAck(c.expected)).toBe(true);
    }
  });

  for (const c of table.forgetOrder) {
    it(`forgetOrder : ${c.name}`, () => {
      const result = forgetOrder(c.declarations as unknown as ForgetDeclaration[]);
      expect(Object.fromEntries(result)).toEqual(c.expected);
    });
  }

  for (const c of table.cutoff) {
    it(`cutoff : ${c.name}`, () => {
      const ackers = c.ackers.map((a) => ({ deviceId: a.deviceId as DeviceId, acks: toAcks(a.acks as JsonAcks) }));
      expect(cutoff(c.target as DeviceId, ackers)).toEqual(c.expected);
    });
  }

  for (const c of table.forgottenDelete) {
    it(`forgottenDeleteCheck : ${c.name}`, () => {
      const known: ForgetKnownDevice[] = c.known.map((d) => ({
        deviceId: d.deviceId as DeviceId,
        status: d.status as ForgetStateStatus,
        state: d.state
          ? { deviceId: d.deviceId as DeviceId, stateSeq: d.state.stateSeq, acks: toAcks(d.state.acks as JsonAcks), forgotten: d.state.forgotten as unknown as ForgottenDevice[] }
          : null,
      }));
      expect(forgottenDeleteCheck(c.target as DeviceId, c.self as DeviceId, known)).toEqual(c.expected);
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

const declArb: fc.Arbitrary<ForgetDeclaration> = fc
  .record({ by: fc.constantFrom(...DEVICES), target: fc.constantFrom(...DEVICES), n: fc.integer({ min: 0, max: 40 }), counter: fc.integer({ min: 0, max: 3 }), foreignHlc: fc.boolean() })
  .map(({ by, target, n, counter, foreignHlc }) => ({ by, entry: { deviceId: target, at: hlcOf(n, foreignHlc ? (DEVICES[(DEVICES.indexOf(by) + 1) % DEVICES.length] as DeviceId) : by, counter), lastAck: null } }));

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

  it('chaque oubli retenu correspond à une déclaration lue, datée par son auteur', () => {
    fc.assert(
      fc.property(fc.array(declArb, { maxLength: 24 }), (decls) => {
        for (const [target, verdict] of forgetOrder(decls)) {
          expect(decls.some((d) => d.by === verdict.by && d.entry.deviceId === target && d.entry.at === verdict.at && d.entry.at.endsWith(d.by))).toBe(true);
        }
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
