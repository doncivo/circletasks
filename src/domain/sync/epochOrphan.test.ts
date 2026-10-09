import { describe, expect, it } from 'vitest';
import type { DeviceId } from '../types';
import { epochId } from './format';
import { isOrphanEpoch, unreadableDevices } from './epoch';

const ME = '11111111-1111-4111-8111-111111111111' as DeviceId;
const PC = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const E = epochId(1, ME);
const base = {
  epoch: E,
  ownStateOk: false,
  ownStateStatus: 'missing',
  acksOnSelf: 0,
  localStateSeq: 0,
  storedSnapshot: { epoch: E, seq: 1 },
  ownEpochs: [{ epoch: E, segments: [], snapshots: [1] }],
} as const;

describe('isOrphanEpoch (ADR 0011 §24 point 2)', () => {
  it('preuve tenue', () => expect(isOrphanEpoch(base)).toBe(true));
  it.each([
    ['aucune époque', { epoch: null }],
    ['état lisible', { ownStateOk: true }],
    ['état dans le nuage', { ownStateStatus: 'cloud-pending' }],
    ['état étranger', { ownStateStatus: 'foreign' }],
    ['accusé d’un autre appareil', { acksOnSelf: 1 }],
    ['stateSeq écrit', { localStateSeq: 1 }],
    ['instantané non enregistré localement', { storedSnapshot: null }],
    ['instantané d’une autre époque', { storedSnapshot: { epoch: epochId(2, ME), seq: 1 } }],
    ['segment présent', { ownEpochs: [{ epoch: E, segments: [1], snapshots: [1] }] }],
    ['second instantané', { ownEpochs: [{ epoch: E, segments: [], snapshots: [1, 2] }] }],
    ['numéro d’instantané différent', { ownEpochs: [{ epoch: E, segments: [], snapshots: [2] }] }],
    ['autre époque listée', { ownEpochs: [{ epoch: E, segments: [], snapshots: [1] }, { epoch: epochId(2, ME), segments: [], snapshots: [1] }] }],
  ])('refusée : %s', (_name, change) => expect(isOrphanEpoch({ ...base, ...change } as never)).toBe(false));
});

describe('unreadableDevices (ADR 0011 §24 point 1)', () => {
  const device = (stateStatus: string, epochs: unknown[] = [], pending: unknown[] = [], deviceId: DeviceId = PC) => ({ deviceId, stateStatus, epochs, pending });
  const none = { has: () => false };
  it('état dans le nuage, fichiers en attente, époques sans état lisible : bloquent', () => {
    expect(unreadableDevices([device('cloud-pending')], ME, none)).toHaveLength(1);
    expect(unreadableDevices([device('ok', [], [{}])], ME, none)).toHaveLength(1);
    expect(unreadableDevices([device('missing', [{}])], ME, none)).toHaveLength(1);
    expect(unreadableDevices([device('corrupt', [{}])], ME, none)).toHaveLength(1);
  });
  it('état lisible, dossier vide, appareil étranger, soi-même, oublié : ne bloquent pas', () => {
    expect(unreadableDevices([device('ok', [{}])], ME, none)).toHaveLength(0);
    expect(unreadableDevices([device('missing')], ME, none)).toHaveLength(0);
    expect(unreadableDevices([device('foreign', [{}])], ME, none)).toHaveLength(0);
    expect(unreadableDevices([device('cloud-pending', [], [], ME)], ME, none)).toHaveLength(0);
    expect(unreadableDevices([device('cloud-pending')], ME, { has: (id) => id === PC })).toHaveLength(0);
  });
});
