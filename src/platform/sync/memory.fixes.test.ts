// Lot Y1, corrections de la revue : mêmes règles que Rust pour la reconstruction de `own.json` (revue 4) et le `kid` d'un appareil
// dont l'état manque ou reste dans le nuage (revue 16). Tests jumeaux de `src-tauri/tests/desktop/sync_fixes.rs` (r4, r16).
import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../../domain/types';
import { epochId, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../domain/sync/format';
import { MemorySyncFolder, createMemorySyncPlatform, type MemorySyncPlatform } from './memory';
import { SyncPlatformError } from './types';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const E1 = epochId(1, A);
const hlc = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;
const now = (): number => 1_800_000_000_000;

const stateOf = (stateSeq: number, head: { segment: number; record: number; hlc: Hlc | null }, epoch: EpochId = E1): PublishedDeviceState => ({
  deviceId: A,
  platform: 'windows',
  appVersion: '0.1.1',
  sm: 1,
  sv: 14,
  epoch,
  stateSeq,
  head: { epoch, ...head, stateSeq },
  acks: new Map<DeviceId, DeviceAck>(),
  snapshot: null,
  purgeHorizon: null,
  lastSyncHlc: hlc(1_000),
  forgotten: [],
  reset: null,
});

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof SyncPlatformError ? error.code : String(error);
  }
};

async function published(folder: MemorySyncFolder): Promise<MemorySyncPlatform> {
  const a = createMemorySyncPlatform({ folder, nowMs: now });
  await a.folder.choose();
  await a.bindDevice(A);
  await a.key.create();
  await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(100), records: ['{}'] });
  await a.writeState({ sv: 14, state: stateOf(5, { segment: 1, record: 1, hlc: hlc(100) }) });
  return a;
}

describe('memory.ts, corrections du lot Y1', () => {
  it('revue 4 : propre state.ctx dans le nuage sans accusé : cloud-pending, rien retenu ; lisible ensuite', async () => {
    const folder = new MemorySyncFolder();
    const a = await published(folder);
    a.testing.dropOwnState();
    folder.setAvailability(A, 'state.ctx', 'cloud');
    const next = { epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(200), records: ['{}'] };
    expect(await codeOf(a.appendJournal(next))).toBe('cloud-pending');
    expect(await codeOf(a.appendJournal(next))).toBe('cloud-pending');
    folder.setAvailability(A, 'state.ctx', 'local');
    expect(await codeOf(a.appendJournal({ ...next, maxHlc: hlc(100) }))).toBe('hlc-order');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(5, { segment: 1, record: 1, hlc: hlc(100) }) }))).toBe('state-mismatch');
  });

  it('revue 16 : état dans le nuage : kid tiré d’un fichier présent', async () => {
    const folder = new MemorySyncFolder();
    const a = await published(folder);
    folder.setAvailability(A, 'state.ctx', 'cloud');
    const scan = await a.scan({ keep: [] });
    expect(scan.devices[0]?.stateStatus).toBe('cloud-pending');
    expect(scan.devices[0]?.kid).toBe((await a.key.status()).kid);
  });
});
