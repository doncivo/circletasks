import { describe, expect, it } from 'vitest';
import { dedupAcknowledged, duplicateGroups, reconcileGroup, type GroupRow, type OccurrenceRow } from './occurrenceDedup';
import { asEntityId, type DeviceId, type Hlc, type RecurrenceId, type TaskId } from './types';
import type { DeviceAck, EpochId } from './sync/format';

const R = asEntityId<RecurrenceId>('11111111-1111-4111-8111-111111111111');
const id = (n: number): TaskId => asEntityId<TaskId>(`2000000${String(n)}-0000-4000-8000-000000000000`);
const hlc = (n: number): Hlc => `2026-10-18T10:00:0${String(n)}.000Z-0000-aaaa` as Hlc;
const row = (n: number, seriesIndex: number, extra: Partial<OccurrenceRow> = {}): OccurrenceRow => ({ id: id(n), recurrenceId: R, seriesIndex, done: false, hlc: hlc(n), ...extra });

describe('R1 : preuve de convergence du nettoyage', () => {
  const writer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
  const peer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
  const epoch = `e0001-${writer}` as EpochId;
  const write = `001792756801000-0001-${writer}` as Hlc;
  type Reader = Parameters<typeof dedupAcknowledged>[1][number];
  const reader = (patch: Partial<Reader> = {}): Reader => ({ deviceId: peer, status: 'active', lastSeenHlc: write, acks: new Map([[writer, { epoch, segment: 1, record: 2, hlc: write, stateSeq: 1 }]]), epoch, stateEpoch: epoch, cursor: { segment: 1, record: 2 }, head: { segment: 1, record: 2 }, ...patch });

  it('un accusé absent ou antérieur ne clôt pas le suivi ; un accusé couvrant la suppression le permet', () => {
    expect(dedupAcknowledged(write, [reader({ acks: new Map<DeviceId, DeviceAck>() })])).toBe(false);
    expect(dedupAcknowledged(write, [reader({ acks: new Map([[writer, { epoch, segment: 1, record: 1, hlc: `001792756801000-0000-${writer}` as Hlc, stateSeq: 1 }]]) })])).toBe(false);
    expect(dedupAcknowledged(write, [reader()])).toBe(true);
    expect(dedupAcknowledged(write, [])).toBe(true);
  });

  it('un journal non entièrement lu, une autre époque ou un état corrompu retiennent le suivi malgré les accusés', () => {
    expect(dedupAcknowledged(write, [reader({ cursor: { segment: 1, record: 1 } })])).toBe(false);
    expect(dedupAcknowledged(write, [reader({ stateEpoch: `e0002-${writer}` as EpochId })])).toBe(false);
    expect(dedupAcknowledged(write, [reader({ status: 'corrupt' })])).toBe(false);
  });
});

describe('survivant d’un groupe de doublons (T-TECH-01 D7, critère 15)', () => {
  it('(a) deux à faire : le hlc le plus récent', () => {
    expect(duplicateGroups([row(1, 5), row(2, 5)])).toEqual([{ recurrenceId: R, seriesIndex: 5, survivor: id(2), discarded: [id(1)] }]);
  });

  it('(b) une terminée : elle survit même avec le hlc le plus ancien', () => {
    expect(duplicateGroups([row(1, 6, { done: true }), row(2, 6)])[0]).toMatchObject({ survivor: id(1), discarded: [id(2)] });
  });

  it('(c) deux terminées : le hlc le plus récent, puis l’identifiant le plus petit à hlc égal', () => {
    expect(duplicateGroups([row(1, 7, { done: true }), row(2, 7, { done: true })])[0]?.survivor).toBe(id(2));
    expect(duplicateGroups([row(3, 7, { done: true, hlc: hlc(9) }), row(1, 7, { done: true, hlc: hlc(9) })])[0]?.survivor).toBe(id(1));
  });

  it('(d) trois lignes : un seul survivant, les deux autres écartées', () => {
    const [group] = duplicateGroups([row(1, 8), row(3, 8), row(2, 8)]);
    expect(group?.survivor).toBe(id(3));
    expect(group?.discarded).toEqual([id(1), id(2)]);
  });

  it('(e) (f) (g) une ligne seule, le marqueur -1 et l’absence d’index ne sont jamais des doublons', () => {
    expect(duplicateGroups([row(1, 9)])).toEqual([]);
    expect(duplicateGroups([row(1, -1), row(2, -1)])).toEqual([]);
  });

  it('le résultat ne dépend pas de l’ordre d’entrée', () => {
    const rows = [row(1, 5), row(2, 5), row(3, 6, { done: true }), row(4, 6)];
    expect(duplicateGroups([...rows].reverse())).toEqual(duplicateGroups(rows));
  });

  it('séries différentes : jamais regroupées', () => {
    const other = asEntityId<RecurrenceId>('33333333-3333-4333-8333-333333333333');
    expect(duplicateGroups([row(1, 5), { ...row(2, 5), recurrenceId: other }])).toEqual([]);
  });
});

describe('rétablissement après un nettoyage aux données différentes (T-TECH-01 B2)', () => {
  const g = (n: number, extra: Partial<GroupRow> = {}): GroupRow => ({ ...row(n, 1), live: false, ...extra });

  it('aucune ligne vivante : la ligne désignée par D7 revient (terminée d’abord, puis hlc, puis id)', () => {
    expect(reconcileGroup([g(1), g(2)])).toEqual({ restore: id(2), discard: [] });
    expect(reconcileGroup([g(1, { done: true }), g(2)])).toEqual({ restore: id(1), discard: [] });
  });

  it('une vivante à faire et une terminée à la corbeille : la terminée revient, la vivante est écartée', () => {
    expect(reconcileGroup([g(1, { done: true }), g(2, { live: true })])).toEqual({ restore: id(1), discard: [id(2)] });
  });

  it('groupe stable (une vivante, ou une vivante terminée) : rien, le hlc d’une ligne écartée ne défait pas le nettoyage', () => {
    expect(reconcileGroup([g(1), g(2, { live: true })])).toEqual({ restore: null, discard: [] });
    expect(reconcileGroup([g(1, { done: true, live: true }), g(2, { done: true })])).toEqual({ restore: null, discard: [] });
  });

  it('R1 : une suppression non attribuée au nettoyage ne peut être rétablie, ni entraîner la suppression de la vivante', () => {
    const rows = [g(1, { done: true }), g(2, { live: true })];
    expect(reconcileGroup(rows, new Set())).toEqual({ restore: null, discard: [] });
    expect(reconcileGroup(rows, new Set([id(1)]))).toEqual({ restore: id(1), discard: [id(2)] });
  });
});
