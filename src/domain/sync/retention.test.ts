import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { epochId, type DeviceAck, type ForgottenDevice, type JournalRecord, type PublishedDeviceState } from './format';
import { isTooFarAhead, recordIsAhead, recordMaxHlc } from './drift';
import { DEVICE_EXPIRY_MS, HLC_MAX_DRIFT_MS, MAX_OWN_STATE_MARKS } from './limits';
import { activeReaders, addOwnStateMark, BLOCKED, canPurgeDeletion, coveredSegment, decideSegmentGap, ownStateFloor, type OwnStateMark, isExpired, publishedAllRead, purgeBefore, purgeExplainsMissingSegment, purgeHorizon, readByAll, segmentPurgeable, UNBOUNDED, type KnownDevice } from './retention';

/**
 * Rétention et dérive (ADR 0011, sections 3.4, 4.4, 5.3 à 5.5 ; Y-09 critères 2, 6, 7 et 10). Règle validée par Ali : une trace est
 * conservée **au moins 30 jours** après la suppression **et** tant que tous les appareils actifs ne l'ont pas lue.
 */

const SELF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-05T08:00:00.000Z');
const h = (ms: number, dev: string = SELF): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const E1 = epochId(1, SELF);
const ack = (hlc: Hlc | null, segment = 1): DeviceAck => ({ epoch: E1, segment, record: 0, hlc, stateSeq: 1 });
const device = (deviceId: DeviceId, acks: [DeviceId, DeviceAck][], status = 'active', lastSeenMs = NOW): KnownDevice => ({ deviceId, status, lastSeenHlc: h(lastSeenMs, deviceId), acks: new Map(acks) });

/** Suppression faite par SELF il y a `daysAgo` jours (deleted_at et hlc concordants). */
const deletion = (daysAgo: number): { deletedAt: IsoDateTime; deletedHlc: Hlc } => ({ deletedAt: new Date(NOW - daysAgo * DAY).toISOString() as IsoDateTime, deletedHlc: h(NOW - daysAgo * DAY) });

describe('purge des traces : les deux conditions (Y-09 D1, validée par Ali)', () => {
  it('30 jours écoulés mais un appareil actif n’a pas lu la suppression : gardée', () => {
    const d = deletion(31);
    const horizon = purgeHorizon([device(B, [[SELF, ack(h(NOW - 40 * DAY))]])], SELF, NOW);
    expect(canPurgeDeletion(d, horizon, NOW)).toBe(false);
  });

  it('tous les appareils ont lu mais 29 jours seulement : gardée', () => {
    const d = deletion(29);
    const horizon = purgeHorizon([device(B, [[SELF, ack(h(NOW))]])], SELF, NOW);
    expect(canPurgeDeletion(d, horizon, NOW)).toBe(false);
  });

  it('30 jours écoulés et lue par tous : purgée', () => {
    const d = deletion(30);
    const horizon = purgeHorizon([device(B, [[SELF, ack(h(NOW))]]), device(C, [[SELF, ack(d.deletedHlc)]])], SELF, NOW);
    expect(canPurgeDeletion(d, horizon, NOW)).toBe(true);
    expect(purgeBefore(NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('sans autre appareil actif (synchro non configurée) : seule la règle des 30 jours de T-08', () => {
    expect(purgeHorizon([], SELF, NOW)).toBe(UNBOUNDED);
    expect(canPurgeDeletion(deletion(30), UNBOUNDED, NOW)).toBe(true);
    expect(canPurgeDeletion(deletion(29), UNBOUNDED, NOW)).toBe(false);
    expect(canPurgeDeletion({ deletedAt: 'x' as IsoDateTime, deletedHlc: h(1) }, UNBOUNDED, NOW)).toBe(false);
  });

  it('suppression écrite par un autre appareil : chaque lecteur sauf l’écrivain doit l’avoir lue ; l’écrivain ne se bloque pas lui-même', () => {
    const del = { deletedAt: new Date(NOW - 40 * DAY).toISOString() as IsoDateTime, deletedHlc: h(NOW - 40 * DAY, B) };
    const unread = purgeHorizon([device(B, []), device(C, [[B, ack(null)]])], SELF, NOW);
    expect(canPurgeDeletion(del, unread, NOW)).toBe(false);
    const read = purgeHorizon([device(B, []), device(C, [[B, ack(h(NOW, B))]])], SELF, NOW);
    expect(canPurgeDeletion(del, read, NOW)).toBe(true);
  });
});

describe('appareils inactifs et sans état valide (Y-09 critère 2, section 3.4)', () => {
  it('absent depuis plus de 180 jours : expired, ne bloque plus ; moins de 180 jours : bloque', () => {
    const old = device(B, [], 'active', NOW - 181 * DAY);
    const recent = device(C, [], 'active', NOW - 179 * DAY);
    expect(isExpired(old.lastSeenHlc, NOW)).toBe(true);
    expect(isExpired(recent.lastSeenHlc, NOW)).toBe(false);
    expect(activeReaders([old, recent], SELF, NOW).map((d) => d.deviceId)).toEqual([C]);
    expect(readByAll(h(NOW - 40 * DAY), purgeHorizon([old], SELF, NOW))).toBe(true);
    expect(readByAll(h(NOW - 40 * DAY), purgeHorizon([recent], SELF, NOW))).toBe(false);
  });

  it('état invalide (foreign, corrupt, rollback) : son dernier accusé connu compte, sans rien débloquer de plus', () => {
    for (const status of ['foreign', 'corrupt', 'rollback']) {
      const stuck = device(B, [[SELF, ack(h(NOW - 35 * DAY))]], status);
      expect(readByAll(h(NOW - 36 * DAY), purgeHorizon([stuck], SELF, NOW))).toBe(true);
      expect(readByAll(h(NOW - 34 * DAY), purgeHorizon([stuck], SELF, NOW))).toBe(false);
    }
    expect(activeReaders([device(B, [], 'forgotten'), device(C, [], 'expired')], SELF, NOW)).toEqual([]);
  });
});

describe('purge de ses segments (section 5.3)', () => {
  const readers = [device(B, [[SELF, ack(h(NOW), 4)]])];
  const base = { headSegment: 5, coveredSegment: 4, readers, self: SELF, lastWriteMs: NOW - 31 * DAY, nowMs: NOW, epoch: E1 };
  it('couvert par un instantané, accusé par tous, plus de 30 jours : supprimable ; jamais la tête', () => {
    expect(segmentPurgeable(3, base)).toBe(true);
    expect(segmentPurgeable(4, base)).toBe(false);
    expect(segmentPurgeable(5, { ...base, coveredSegment: 9 })).toBe(false);
    expect(segmentPurgeable(3, { ...base, lastWriteMs: NOW - 29 * DAY })).toBe(false);
    expect(segmentPurgeable(3, { ...base, lastWriteMs: null })).toBe(false);
    expect(segmentPurgeable(3, { ...base, readers: [device(B, [[SELF, ack(h(NOW), 3)]])] })).toBe(false);
  });
});

describe('dérive d’horloge (Y-09 critère 10)', () => {
  const record = (hlc: Hlc, base: Hlc | null = null): JournalRecord => ({ k: 'ops', sv: 17, ops: [{ t: 'task', id: 'x', at: 'x' as IsoDateTime, f: new Map([['title', ['a', hlc, base]]]) }] });
  it('au-delà de nowMs() + 1 h sur l’horloge physique : refusé ; exactement 1 h : accepté', () => {
    expect(isTooFarAhead(h(NOW + HLC_MAX_DRIFT_MS, B), NOW)).toBe(false);
    expect(isTooFarAhead(h(NOW + HLC_MAX_DRIFT_MS + 1, B), NOW)).toBe(true);
    expect(recordIsAhead(record(h(NOW, B), h(NOW + 2 * HLC_MAX_DRIFT_MS, B)), NOW)).toBe(true);
    expect(recordIsAhead(record(h(NOW + 10, B)), NOW)).toBe(false);
    expect(recordMaxHlc(record(h(NOW, B)))).toBe(h(NOW, B));
    expect(recordMaxHlc({ k: 'ops', sv: 17, ops: [] })).toBeNull();
  });
});

describe('publishedAllRead (revue Y2 passe 2, point 1)', () => {
  const base = { status: 'active', epoch: 'e1', stateEpoch: 'e1', cursor: { segment: 2, record: 3 }, head: { segment: 2, record: 3 } };
  it('tête lue : vrai ; curseur avant la tête, autre époque ou état invalide : faux ; état jamais reçu : vrai', () => {
    expect(publishedAllRead(base)).toBe(true);
    expect(publishedAllRead({ ...base, cursor: { segment: 3, record: 0 } })).toBe(true);
    expect(publishedAllRead({ ...base, cursor: { segment: 2, record: 2 } })).toBe(false);
    expect(publishedAllRead({ ...base, cursor: { segment: 1, record: 9 } })).toBe(false);
    expect(publishedAllRead({ ...base, epoch: 'e0' })).toBe(false);
    expect(publishedAllRead({ ...base, status: 'corrupt' })).toBe(false);
    expect(publishedAllRead({ ...base, stateEpoch: null })).toBe(true);
  });
  it('horizon bloqué : rien n’est lu par tous', () => {
    expect(readByAll(`001791187200000-0000-${'b'.repeat(8)}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` as never, BLOCKED)).toBe(false);
  });
});

describe('Y-TECH-02 (QA) : segment absent de la liste, purge possible ?', () => {
  const at = (ms: number) => `${String(ms).padStart(15, '0')}-0000-0f8fad5b-d9cb-469f-a165-70867728950e` as Hlc;
  const DAY = 86_400_000;
  it('sans instantané publié : jamais ; hlc lu de moins de 30 jours : jamais ; au-delà, ou rien lu : possible', () => {
    const now = 100 * DAY;
    expect(purgeExplainsMissingSegment({ snapshot: null, acks: new Map<DeviceId, DeviceAck>(), forgotten: [] }, null, now)).toBe(false);
    expect(purgeExplainsMissingSegment({ snapshot: { seq: 1, endHlc: at(0) }, acks: new Map<DeviceId, DeviceAck>(), forgotten: [] }, at(now - DAY), now)).toBe(false);
    expect(purgeExplainsMissingSegment({ snapshot: { seq: 1, endHlc: at(0) }, acks: new Map<DeviceId, DeviceAck>(), forgotten: [] }, at(now - 30 * DAY), now)).toBe(true);
    expect(purgeExplainsMissingSegment({ snapshot: { seq: 1, endHlc: at(0) }, acks: new Map<DeviceId, DeviceAck>(), forgotten: [] }, null, now)).toBe(true);
  });
});

describe('Y-TECH-02 (troisième revue, point 2 ; quatrième revue, point D) : segment absent, preuve par l’état accepté de l’écrivain (ADR 0011 §5.5)', () => {
  const now = 400 * DAY;
  const k = 5;
  const old = h(now - 40 * DAY, B);
  const ownAck: DeviceAck = { epoch: E1, segment: k, record: 0, hlc: old, stateSeq: 3 };
  /** État accepté de l'écrivain B : instantané annoncé, ses accusés, ses oublis. */
  const writer = (acks: [DeviceId, DeviceAck][], forgotten: ForgottenDevice[] = []): Pick<PublishedDeviceState, 'snapshot' | 'acks' | 'forgotten'> => ({ snapshot: { seq: 1, endHlc: h(now - 50 * DAY, B) }, acks: new Map(acks), forgotten });
  /** B nous connaît : accusé sur nous, état de nous accepté `stateSeq`, hlc de notre enregistrement lu (null : aucun). */
  const knowsUs = (stateSeq = 7, hlcMs: number | null = now - DAY): [DeviceId, DeviceAck][] => [[SELF, { epoch: E1, segment: 2, record: 0, hlc: hlcMs === null ? null : h(hlcMs, SELF), stateSeq }]];
  /** Nos repères : état 7 publié il y a `daysAgo` jours. */
  const marks = (daysAgo = 2): OwnStateMark[] => [[3, h(now - 300 * DAY)], [7, h(now - daysAgo * DAY)], [9, h(now - DAY / 2)]];
  const own = (a: DeviceAck | null = ownAck, m: readonly OwnStateMark[] = marks()) => ({ self: SELF, segment: k, epoch: E1, ownAck: a, marks: m });
  const explains = (w: Pick<PublishedDeviceState, 'snapshot' | 'acks' | 'forgotten'>, o = own()) => purgeExplainsMissingSegment(w, old, now, o);

  it('l’écrivain ne nous connaît pas (aucun accusé sur nous), dernier hlc lu de 40 jours, ownAck ≤ k : purge possible (reprise)', () => {
    expect(explains(writer([]))).toBe(true);
  });

  it('point D : accusé sans hlc mais état de nous accepté récent : attente (le hlc de l’accusé n’est plus exigé)', () => {
    expect(explains(writer(knowsUs(7, null)))).toBe(false);
  });

  it('point D : état de nous accepté daté par nos repères, au-delà de 180 jours moins la marge : purge possible ; juste en deçà : attente', () => {
    const limit = now + HLC_MAX_DRIFT_MS - DEVICE_EXPIRY_MS;
    expect(explains(writer(knowsUs()), own(ownAck, [[7, h(limit)]]))).toBe(true);
    expect(explains(writer(knowsUs()), own(ownAck, [[7, h(limit + 1)]]))).toBe(false);
  });

  it('point D : stateSeq accepté ancien avec un accusé de hlc récent (nos journaux arrivent, plus notre état) : purge possible', () => {
    expect(explains(writer(knowsUs(3, now - DAY)))).toBe(true);
  });

  it('point D : stateSeq récent avec un hlc d’accusé ancien : attente', () => {
    expect(explains(writer(knowsUs(8, now - 300 * DAY)))).toBe(false);
  });

  it('point D : aucun repère (illisible ou pas encore écrit) : aucune preuve, règle des 30 jours', () => {
    expect(explains(writer(knowsUs()), own(ownAck, []))).toBe(true);
    expect(purgeExplainsMissingSegment(writer(knowsUs()), h(now - DAY, B), now, own(ownAck, []))).toBe(false);
  });

  it('l’écrivain nous oublie : purge possible', () => {
    const forgotten: ForgottenDevice[] = [{ deviceId: SELF, at: h(now - DAY, B), lastAck: null }];
    expect(explains(writer(knowsUs(), forgotten))).toBe(true);
  });

  it('l’écrivain nous compte (état accepté récent) et ownAck ≤ k : attente, quel que soit l’âge du dernier hlc lu', () => {
    expect(explains(writer(knowsUs()))).toBe(false);
    expect(explains(writer(knowsUs()), own({ ...ownAck, segment: k - 1 }))).toBe(false);
    expect(purgeExplainsMissingSegment(writer(knowsUs()), null, now, own())).toBe(false);
  });

  it('ownAck d’une autre époque, au-delà de k ou absent : aucune preuve, purge possible', () => {
    const w = writer(knowsUs());
    expect(explains(w, own({ ...ownAck, epoch: epochId(2, SELF) }))).toBe(true);
    expect(explains(w, own({ ...ownAck, segment: k + 1 }))).toBe(true);
    expect(explains(w, own(null))).toBe(true);
  });

  it('sans preuve, la règle des 30 jours reste : sans instantané ou dernier hlc lu récent, jamais', () => {
    expect(purgeExplainsMissingSegment({ ...writer([]), snapshot: null }, old, now, own())).toBe(false);
    expect(purgeExplainsMissingSegment(writer([]), h(now - DAY, B), now, own())).toBe(false);
  });
});

describe('quatrième revue, point D : repères de ses états publiés (ownStateFloor, addOwnStateMark)', () => {
  const at = (ms: number): Hlc => h(ms);
  it('borne basse : plus grand repère de stateSeq inférieur ou égal ; aucun : null', () => {
    const marks: OwnStateMark[] = [[3, at(NOW - 10 * DAY)], [7, at(NOW - 5 * DAY)], [12, at(NOW - DAY)]];
    expect(ownStateFloor(marks, 2)).toBeNull();
    expect(ownStateFloor(marks, 3)).toBe(at(NOW - 10 * DAY));
    expect(ownStateFloor(marks, 11)).toBe(at(NOW - 5 * DAY));
    expect(ownStateFloor(marks, 40)).toBe(at(NOW - DAY));
    expect(ownStateFloor([], 40)).toBeNull();
  });

  it('espacement : un repère par jour au plus ; liste vide : ajouté', () => {
    let marks = addOwnStateMark([], 1, at(NOW), NOW);
    expect(marks).toEqual([[1, at(NOW)]]);
    marks = addOwnStateMark(marks, 2, at(NOW + DAY - 1), NOW + DAY - 1);
    expect(marks).toEqual([[1, at(NOW)]]);
    marks = addOwnStateMark(marks, 3, at(NOW + DAY), NOW + DAY);
    expect(marks).toEqual([[1, at(NOW)], [3, at(NOW + DAY)]]);
  });

  it('élagage : repères de plus de 180 jours + la marge retirés ; 182 au plus', () => {
    const limit = DEVICE_EXPIRY_MS + HLC_MAX_DRIFT_MS;
    const marks: OwnStateMark[] = [[1, at(NOW - limit - 1)], [2, at(NOW - limit)]];
    expect(addOwnStateMark(marks, 3, at(NOW), NOW)).toEqual([[2, at(NOW - limit)], [3, at(NOW)]]);
    const many: OwnStateMark[] = Array.from({ length: 182 }, (_, i) => [i + 1, at(NOW - (182 - i) * (DAY / 2))] as const);
    const next = addOwnStateMark(many, 500, at(NOW + DAY), NOW + DAY);
    expect(next).toHaveLength(MAX_OWN_STATE_MARKS);
    expect(next[0]).toEqual(many[1]);
    expect(next.at(-1)).toEqual([500, at(NOW + DAY)]);
  });
});

describe('Y-TECH-02 (troisième revue, point 2) : segmentPurgeable, époque des accusés (ADR 0011 §5.3)', () => {
  const E2 = epochId(2, SELF);
  const E3 = epochId(3, SELF);
  const base = { headSegment: 5, coveredSegment: 4, self: SELF, lastWriteMs: NOW - 31 * DAY, nowMs: NOW, epoch: E2 };
  const reader = (a: DeviceAck) => [device(B, [[SELF, a]])];
  it('accusé d’une époque antérieure au-delà du segment : ne vaut rien (réinitialisation, accusé figé)', () => {
    expect(segmentPurgeable(3, { ...base, readers: reader({ ...ack(h(NOW), 9), epoch: E1 }) })).toBe(false);
  });
  it('même époque au-delà du segment : lu ; époque postérieure : lu', () => {
    expect(segmentPurgeable(3, { ...base, readers: reader({ ...ack(h(NOW), 4), epoch: E2 }) })).toBe(true);
    expect(segmentPurgeable(3, { ...base, readers: reader({ ...ack(h(NOW), 1), epoch: E3 }) })).toBe(true);
    expect(segmentPurgeable(3, { ...base, readers: reader({ ...ack(h(NOW), 3), epoch: E2 }) })).toBe(false);
  });
});

describe('quatrième revue, point C : coveredSegment (ADR 0011 §5.3)', () => {
  const E2 = epochId(2, SELF);
  const state = (epoch: typeof E1, a: DeviceAck) => ({ epoch, acks: new Map([[SELF, a]]) });
  it('accusés de l’époque des lecteurs actifs seulement ; instantané éligible compté', () => {
    const readers = [device(B, [])];
    const base = { epoch: E2, self: SELF, readers, ownSnapshotSegment: 0 };
    expect(coveredSegment({ ...base, accepted: new Map([[B, state(E2, { ...ack(h(NOW), 4), epoch: E2 })]]) })).toBe(4);
    expect(coveredSegment({ ...base, accepted: new Map([[B, state(E2, { ...ack(h(NOW), 50), epoch: E1 })]]) }), 'accusé d’une autre époque').toBe(0);
    expect(coveredSegment({ ...base, accepted: new Map([[C, state(E2, { ...ack(h(NOW), 50), epoch: E2 })]]) }), 'pas un lecteur actif').toBe(0);
    expect(coveredSegment({ ...base, accepted: new Map([[B, state(E1, { ...ack(h(NOW), 50), epoch: E2 })]]) }), 'état d’une autre époque').toBe(0);
    expect(coveredSegment({ ...base, readers: [], accepted: new Map<DeviceId, ReturnType<typeof state>>(), ownSnapshotSegment: 7 })).toBe(7);
  });
});

describe('quatrième revue, point B : decideSegmentGap (ADR 0011 §5.5, trou impossible à combler)', () => {
  const now = '2026-10-07T08:00:00.000Z' as IsoDateTime;
  const snap = { author: B, seq: 3 };
  const base = { existing: undefined, epoch: E1, segment: 2, resumed: false, applied: null, latest: snap, now };
  it('reprise dans ce cycle : trou mémorisé avec l’instantané appliqué, date de première constatation gardée', () => {
    expect(decideSegmentGap({ ...base, resumed: true, applied: snap })).toEqual({ kind: 'record', gap: { epoch: E1, segment: 2, author: B, seq: 3, since: now } });
    const existing = { epoch: E1, segment: 2, author: B, seq: 2, since: '2026-10-01T08:00:00.000Z' as IsoDateTime };
    expect(decideSegmentGap({ ...base, existing, resumed: true, applied: null })).toEqual({ kind: 'record', gap: { epoch: E1, segment: 2, author: null, seq: null, since: existing.since } });
  });
  it('même instantané éligible que la dernière tentative : corrupt gardé, aucune reprise ; nouveau, autre époque ou aucun trou : reprise', () => {
    const existing = { epoch: E1, segment: 2, author: B, seq: 3, since: now };
    expect(decideSegmentGap({ ...base, existing })).toEqual({ kind: 'keep' });
    expect(decideSegmentGap({ ...base, existing, latest: { author: B, seq: 4 } })).toEqual({ kind: 'resume' });
    expect(decideSegmentGap({ ...base, existing: { ...existing, epoch: epochId(2, SELF) } })).toEqual({ kind: 'resume' });
    expect(decideSegmentGap(base)).toEqual({ kind: 'resume' });
    expect(decideSegmentGap({ ...base, existing: { ...existing, author: null, seq: null }, latest: null })).toEqual({ kind: 'keep' });
  });
});
