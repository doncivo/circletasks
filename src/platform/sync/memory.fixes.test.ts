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

  it('revue B1 : propre state.ctx remplacé (corrompu) : reconstruit avec le stateSeq lu en clair, réécriture possible', async () => {
    const folder = new MemorySyncFolder();
    const a = await published(folder);
    a.testing.dropOwnState();
    folder.corruptRecord(A, 'state.ctx', 0);
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(200), records: ['{}'] }))).toBe('resolved');
    const head = { segment: 1, record: 2, hlc: hlc(200) };
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(5, head) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(6, head) }))).toBe('resolved');
  });

  it('revue B1, décision 1 : propre state.ctx d’un format plus récent jamais réécrit (newer-format)', async () => {
    const folder = new MemorySyncFolder();
    const a = await published(folder);
    a.testing.dropOwnState();
    const file = folder.devices.get(A)?.state;
    if (!file) throw new Error('état absent');
    (file.header as { sm: number }).sm = 2;
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(200), records: ['{}'] }))).toBe('newer-format');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(6, { segment: 1, record: 1, hlc: hlc(100) }) }))).toBe('newer-format');
    expect(folder.devices.get(A)?.state).toBe(file);
  });

  it('revue B1, décision 2 : numéro d’en-tête absurde (2^53 - 1) ignoré, réécriture toujours possible', async () => {
    const folder = new MemorySyncFolder();
    const a = await published(folder);
    a.testing.dropOwnState();
    const file = folder.devices.get(A)?.state;
    if (!file) throw new Error('état absent');
    (file.header as { n: number }).n = Number.MAX_SAFE_INTEGER;
    folder.corruptRecord(A, 'state.ctx', 0);
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(200), records: ['{}'] }))).toBe('resolved');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(6, { segment: 1, record: 2, hlc: hlc(200) }) }))).toBe('resolved');
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

// Revue Y-IOS (bloquant) : un instantané dont les pages sont coupées par l'appelant laisse l'écrivain ouvert (comme dans Rust) ; le cycle
// suivant, même époque et même numéro, l'abandonne au lieu de rendre `segment-mismatch` à chaque cycle. Jumeau de `r5` (sync_fixes.rs).
describe('écrivain d’instantané resté ouvert (revue Y-IOS)', () => {
  it('pages coupées, puis même numéro : l’ancien écrivain est abandonné, l’instantané est écrit', async () => {
    const p = createMemorySyncPlatform({ folder: new MemorySyncFolder(), nowMs: now });
    await p.folder.choose();
    await p.bindDevice(A);
    await p.key.create();
    const cut = (async function* () {
      yield ['{"k":"snap-rows"}'];
      throw new Error('cycle interrompu');
    })();
    expect(await codeOf(p.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: cut }))).toBe('Error: cycle interrompu');
    const whole = (async function* () {
      yield ['{"k":"snap-rows"}', '{"k":"snap-end"}'];
    })();
    expect(await codeOf(p.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: whole }))).toBe('resolved');
  });
});
