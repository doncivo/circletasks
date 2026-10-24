import { describe, expect, it } from 'vitest';
import type { SyncStateRow } from '../db/repositories';
import { formatHlc } from '../domain/hlc';
import type { DeviceId, Hlc } from '../domain/types';
import { storedDeviceStatuses } from './deviceStatus';

const OTHER = '50000000-0000-4000-8000-000000000002';
const hlcAt = (ms: number): Hlc => formatHlc({ ms, counter: 0, deviceId: OTHER as DeviceId });

const row = (over: Partial<SyncStateRow>): SyncStateRow => ({
  deviceId: 'd',
  isSelf: false,
  platform: 'ios',
  appVersion: null,
  epoch: null,
  cursorSegment: 0,
  cursorRecord: 0,
  ackHlc: null,
  headSegment: 0,
  headRecord: 0,
  headHlc: null,
  stateEpoch: null,
  stateSeq: 1,
  stateDigest: null,
  lastAcks: '{}',
  lastSeenHlc: null,
  lastSyncAt: null,
  schemaVersion: null,
  formatMajor: null,
  kid: null,
  purgeHorizon: null,
  snapshotSeq: null,
  snapshotHlc: null,
  status: 'active',
  ...over,
});

/** N-07 (ADR 0012 avenant N1.6) : la dernière synchro PUBLIÉE d'un autre appareil n'est pas `lastReadAt`. */
describe('storedDeviceStatuses : publishedSyncAt', () => {
  it('UI-FIX-02 : un accusé HLC nul signifie jamais lu, pas minuit en 1970', () => {
    const [device] = storedDeviceStatuses([row({ deviceId: OTHER, ackHlc: hlcAt(0), lastSeenHlc: hlcAt(0) })], {});
    expect(device?.lastReadAt).toBeNull();
    expect(device?.publishedSyncAt).toBeNull();
  });
  it('UI-FIX-02 : une vraie modification à minuit reste une lecture datée', () => {
    const midnight = '2026-10-24T00:00:00.000Z';
    const [device] = storedDeviceStatuses([row({ deviceId: OTHER, ackHlc: hlcAt(Date.parse(midnight)) })], {});
    expect(device?.lastReadAt).toBe(midnight);
  });
  it('autre appareil : lastSyncHlc du dernier état accepté (last_seen_hlc), distinct de lastReadAt (accusé de sa dernière écriture lue)', () => {
    const published = Date.parse('2026-10-08T07:30:00.000Z');
    const acked = Date.parse('2026-10-08T05:00:00.000Z');
    const [self, other] = storedDeviceStatuses(
      [row({ deviceId: 'a', isSelf: true, platform: 'windows' }), row({ deviceId: 'b', ackHlc: hlcAt(acked), lastSeenHlc: hlcAt(published) })],
      {},
    );
    expect(self).not.toHaveProperty('publishedSyncAt');
    expect(other?.lastReadAt).toBe('2026-10-08T05:00:00.000Z');
    expect(other?.publishedSyncAt).toBe('2026-10-08T07:30:00.000Z');
  });

  it('valeur inconnue : null (l’avertissement du PC la lit comme non synchronisé)', () => {
    const [, other] = storedDeviceStatuses([row({ deviceId: 'a', isSelf: true, platform: 'windows' }), row({ deviceId: 'b' })], {});
    expect(other?.publishedSyncAt).toBeNull();
  });
});
