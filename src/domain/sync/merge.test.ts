import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Hlc } from '../types';
import type { SyncField } from './format';
import { applyToReplica, deletedWhileModified, mergeField, modifiedWhileDeleted, replicaValues, type LocalField, type Replica, type ReplicaOp } from './merge';

/**
 * Fusion par champ (ADR 0011, section 4 ; Y-02 critère 7, Y-05 critères 3 et 4) : règle, conflits et propriétés fast-check (convergence
 * quel que soit l'ordre d'arrivée, idempotence, aucune perte, symétrie des conflits).
 */

const DEVICES = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'] as const;
const h = (ms: number, dev: string = DEVICES[0], counter = 0): Hlc => `${String(ms).padStart(15, '0')}-${counter.toString(16).padStart(4, '0')}-${dev}` as Hlc;
const local = (value: string | null, hlc: Hlc, base: Hlc | null = null, pending = false): LocalField => ({ value, hlc, base, pending });

describe('mergeField (section 4.1, 4.2)', () => {
  it('le plus grand hlc gagne ; un hlc égal ou inférieur ne change rien ; ligne absente : appliqué', () => {
    expect(mergeField(null, ['x', h(1), null])).toEqual({ apply: true, conflict: null });
    expect(mergeField(local('a', h(2)), ['b', h(3), h(2)])).toEqual({ apply: true, conflict: null });
    expect(mergeField(local('a', h(3)), ['b', h(3), null]).apply).toBe(false);
    expect(mergeField(local('a', h(3), h(1)), ['b', h(2), h(1)]).apply).toBe(false);
  });

  it('conflit dans les deux sens (base différente et valeur différente), jamais si la base est la valeur remplacée', () => {
    const remoteWins = mergeField(local('A', h(2, DEVICES[0]), h(1)), ['B', h(3, DEVICES[1]), h(1)]);
    expect(remoteWins.conflict).toEqual({ kept: { value: 'B', hlc: h(3, DEVICES[1]), device: DEVICES[1] }, discarded: { value: 'A', hlc: h(2, DEVICES[0]), device: DEVICES[0] } });
    const localWins = mergeField(local('B', h(3, DEVICES[1]), h(1)), ['A', h(2, DEVICES[0]), h(1)]);
    expect(localWins.conflict).toEqual(remoteWins.conflict);
    expect(mergeField(local('A', h(2)), ['A', h(3, DEVICES[1]), h(1)]).conflict).toBeNull();
    expect(mergeField(local('A', h(2), h(1)), ['B', h(3, DEVICES[1]), h(2)]).conflict).toBeNull();
  });

  it('valeurs d’instantané : conflit seulement contre une écriture locale en attente', () => {
    expect(mergeField(local('A', h(2)), ['B', h(3, DEVICES[1]), null], { fromSnapshot: true }).conflict).toBeNull();
    expect(mergeField(local('A', h(2), null, true), ['B', h(3, DEVICES[1]), null], { fromSnapshot: true }).conflict).not.toBeNull();
  });

  it('suppression contre modification (section 4.2)', () => {
    const deletion: SyncField = ['2026-10-05T08:00:00.000Z', h(5, DEVICES[1]), h(1)];
    const fields = new Map([['title', local('modifié', h(4, DEVICES[0]))], ['deleted_at', local(null, h(1))]]);
    expect(deletedWhileModified(deletion, fields, () => false)?.discarded.device).toBe(DEVICES[0]);
    expect(deletedWhileModified(deletion, fields, () => true)).toBeNull();
    expect(deletedWhileModified([null, h(5), null], fields, () => false)).toBeNull();
    expect(modifiedWhileDeleted({ deletedAt: 'x', deletedHlc: h(5, DEVICES[1]) }, [['t', h(4, DEVICES[0]), h(1)]], false)?.kept.hlc).toBe(h(5, DEVICES[1]));
    expect(modifiedWhileDeleted({ deletedAt: 'x', deletedHlc: h(5, DEVICES[1]) }, [['t', h(4, DEVICES[0]), h(1)]], true)).toBeNull();
    expect(modifiedWhileDeleted({ deletedAt: null, deletedHlc: h(5) }, [['t', h(4), h(1)]], false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Propriétés (section 12)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Écritures aléatoires : appareil, ligne, champ, valeur ; chaque écriture a un hlc unique (horloge de son appareil). */
const writesArb = fc.array(
  fc.record({ device: fc.integer({ min: 0, max: 2 }), row: fc.integer({ min: 0, max: 3 }), field: fc.constantFrom('title', 'note', 'date', 'deleted_at'), value: fc.option(fc.string({ maxLength: 4 }), { nil: null }), ms: fc.integer({ min: 1, max: 50 }) }),
  { minLength: 1, maxLength: 40 },
);

function toOps(writes: readonly { device: number; row: number; field: string; value: string | null; ms: number }[]): ReplicaOp[] {
  return writes.map((w, i) => ({ row: `task|r${String(w.row)}`, fields: new Map([[w.field, [w.value, h(w.ms, DEVICES[w.device], i), null] as SyncField]]) }));
}

/** Aucune perte : chaque champ = valeur au plus grand hlc parmi toutes les écritures. */
function expected(ops: readonly ReplicaOp[]): Replica {
  const out: Replica = new Map();
  for (const op of ops) {
    const row = out.get(op.row) ?? new Map();
    for (const [name, field] of op.fields) {
      const current = row.get(name);
      if (!current || field[1] > current[1]) row.set(name, field);
    }
    out.set(op.row, row);
  }
  return out;
}

describe('propriétés de la fusion (fast-check)', () => {
  it('convergence quel que soit l’ordre d’arrivée, idempotence (relire = rien), aucune perte', () => {
    fc.assert(
      fc.property(writesArb, fc.integer(), (writes, seed) => {
        const ops = toOps(writes);
        const shuffled = fc.sample(fc.shuffledSubarray(ops, { minLength: ops.length, maxLength: ops.length }), { numRuns: 1, seed })[0] ?? ops;
        const r1: Replica = new Map();
        const r2: Replica = new Map();
        applyToReplica(r1, ops);
        applyToReplica(r2, shuffled);
        applyToReplica(r2, ops); // relecture complète
        expect(replicaValues(r2)).toEqual(replicaValues(r1));
        expect(replicaValues(r1)).toEqual(replicaValues(expected(ops)));
      }),
      { numRuns: 200 },
    );
  });

  it('lots : appliquer par paquets dans n’importe quel ordre donne le même état', () => {
    fc.assert(
      fc.property(writesArb, fc.integer({ min: 1, max: 5 }), (writes, size) => {
        const ops = toOps(writes);
        const batches: ReplicaOp[][] = [];
        for (let i = 0; i < ops.length; i += size) batches.push(ops.slice(i, i + size));
        const forward: Replica = new Map();
        const backward: Replica = new Map();
        for (const b of batches) applyToReplica(forward, b);
        for (const b of [...batches].reverse()) applyToReplica(backward, b);
        expect(replicaValues(backward)).toEqual(replicaValues(forward));
      }),
      { numRuns: 200 },
    );
  });

  it('symétrie des conflits : deux appareils qui modifient le même champ depuis la même base inscrivent le même conflit', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 5 }), fc.string({ maxLength: 5 }), fc.integer({ min: 2, max: 100 }), fc.integer({ min: 2, max: 100 }), (va, vb, ma, mb) => {
        const base = h(1, DEVICES[2]);
        const a: SyncField = [va, h(ma, DEVICES[0]), base];
        const b: SyncField = [vb, h(mb, DEVICES[1]), base];
        const onA = mergeField(local(a[0] as string, a[1], base, true), b);
        const onB = mergeField(local(b[0] as string, b[1], base, true), a);
        expect(onA.conflict).toEqual(onB.conflict);
        expect(onA.conflict === null).toBe(va === vb);
      }),
      { numRuns: 300 },
    );
  });
});
