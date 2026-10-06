import { describe, expect, it } from 'vitest';
import type { SyncStateRow } from '../../../src/db/repositories';
import type { DeviceId } from '../../../src/domain/types';
import { storedDeviceStatuses } from '../../../src/sync';

/** Appareils affichés d'après `sync_state` : même règle pour le moteur (APPAREILS) et les bandeaux A-09 avant le premier cycle (revue 5). */

const SELF = '60000000-0000-4000-8000-0000000000a1' as DeviceId;
const PHONE = '60000000-0000-4000-8000-0000000000b2' as DeviceId;
const LAPTOP = '60000000-0000-4000-8000-0000000000c3' as DeviceId;

const row = (deviceId: string, patch: Partial<SyncStateRow> = {}): SyncStateRow => ({
  deviceId,
  isSelf: false,
  platform: 'windows',
  appVersion: null,
  epoch: null,
  cursorSegment: 0,
  cursorRecord: 0,
  ackHlc: null,
  headSegment: 0,
  headRecord: 0,
  headHlc: null,
  stateEpoch: null,
  stateSeq: 0,
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
  ...patch,
});

describe('storedDeviceStatuses', () => {
  it('soi, les appareils dont un état a été accepté ; soi en tête', () => {
    const rows = [row(PHONE, { platform: 'ios', stateSeq: 2, status: 'foreign' }), row(LAPTOP), row(SELF, { isSelf: true })];
    const devices = storedDeviceStatuses(rows, { self: SELF });
    expect(devices.map((d) => [d.deviceId, d.self, d.platform, d.status])).toEqual([
      [SELF, true, 'windows', 'active'],
      [PHONE, false, 'ios', 'foreign'],
    ]);
    expect(storedDeviceStatuses(rows, { self: SELF, accepted: new Set([LAPTOP]) }).map((d) => d.deviceId)).toEqual([SELF, PHONE, LAPTOP]);
  });

  it('sans identifiant local : soi d’après la ligne', () => {
    expect(storedDeviceStatuses([row(SELF, { isSelf: true })], {}).map((d) => d.self)).toEqual([true]);
  });

  it('statut inconnu : signalé « corrupt », jamais « active »', () => {
    expect(storedDeviceStatuses([row(PHONE, { stateSeq: 1, status: 'lost' })], { self: SELF })[0]?.status).toBe('corrupt');
  });
});
