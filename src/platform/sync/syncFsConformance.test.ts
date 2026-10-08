// ADR 0011 §22 point 4 (Y-IOS-01 critère 2) : les cas de la table de conformité de `SyncFs` observables par `SyncPlatform` (fichier absent,
// partiel, dans le nuage) rejoués sur `memory.ts` : mêmes statuts de `readJournal` et `readSnapshot` que Rust sur ses trois implémentations
// (`src-tauri/tests/desktop/sync_fs_conformance.rs`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../../domain/types';
import { epochId, type DeviceAck, type PublishedDeviceState } from '../../domain/sync/format';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from './memory';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const E1 = epochId(1, A);
const SEGMENT = `${E1}/j-00000001.ctj`;
const SNAPSHOT = `${E1}/s-00000001.cts`;
const hlc = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;

const table = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'sync', 'syncfs-conformance.json'), 'utf8')) as {
  readonly cases: readonly { readonly name: string; readonly observable?: boolean }[];
};
const observable = table.cases.filter((c) => c.observable === true).map((c) => c.name);

let nowMs = 1_800_000_000_000;

function state(snapshot: boolean): PublishedDeviceState {
  return {
    deviceId: A,
    platform: 'windows',
    appVersion: '0.1.1',
    sm: 1,
    sv: 14,
    epoch: E1,
    stateSeq: 1,
    head: { epoch: E1, segment: 1, record: 2, hlc: hlc(20), stateSeq: 1 },
    acks: new Map<DeviceId, DeviceAck>(),
    snapshot: snapshot ? { seq: 1, endHlc: hlc(30) } : null,
    purgeHorizon: null,
    lastSyncHlc: hlc(40),
    forgotten: [],
    reset: null,
  };
}

/** A publie deux enregistrements, un instantané et son état ; B, associé par la clé de secours, lit. */
async function twoDevices(): Promise<{ folder: MemorySyncFolder; b: MemorySyncPlatform }> {
  const folder = new MemorySyncFolder();
  const a = createMemorySyncPlatform({ folder, nowMs: () => nowMs });
  await a.folder.choose();
  await a.bindDevice(A);
  await a.key.create();
  await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['{"k":"ops","n":1}', '{"k":"ops","n":2}'] });
  await a.writeSnapshot({
    epoch: E1,
    seq: 1,
    sv: 14,
    records: (async function* () {
      yield ['{"k":"snap-rows"}', '{"k":"snap-end"}'];
    })(),
  });
  await a.writeState({ sv: 14, state: state(true) });
  await a.key.openPairing('show');
  const { recoveryKey } = await a.key.pairingPayload();
  await a.key.closePairing();
  const b = createMemorySyncPlatform({ folder, nowMs: () => nowMs });
  await b.folder.choose();
  await b.bindDevice(B);
  await b.key.openPairing('import');
  await b.key.import({ recoveryKey });
  await b.scan({ keep: [] });
  return { folder, b };
}

const journal = (b: MemorySyncPlatform) => b.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } });
const tail = (b: MemorySyncPlatform) => b.readSnapshot({ deviceId: A, epoch: E1, seq: 1, fromRecord: 0, tail: true });

beforeEach(() => {
  nowMs = 1_800_000_000_000;
});

describe('table de conformité de SyncFs, cas observables (ADR 0011 §22 point 4)', () => {
  it('la table désigne les trois cas observables rejoués ici', () => {
    expect(observable).toEqual(['fichier absent', 'fichier partiel (dernière ligne incomplète)', 'fichier dans le nuage sans hydratation']);
  });

  it('fichier absent : en attente d’iCloud, jamais sauté', async () => {
    const { folder, b } = await twoDevices();
    expect((await journal(b)).status).toBe('complete');
    folder.removeFile(A, SEGMENT);
    expect(await journal(b)).toMatchObject({ records: [], status: 'cloud-pending' });
    folder.removeFile(A, SNAPSHOT);
    expect((await tail(b)).status).toBe('cloud-pending');
  });

  it('fichier partiel (dernière ligne incomplète) : en attente, rien d’inventé', async () => {
    const { folder, b } = await twoDevices();
    folder.setPartialTail(A, SNAPSHOT, true);
    expect(await tail(b)).toMatchObject({ records: [], status: 'cloud-pending' });
    folder.setPartialTail(A, SNAPSHOT, false);
    expect((await tail(b)).status).toBe('complete');
  });

  it('fichier dans le nuage sans hydratation, puis avec, puis délai dépassé', async () => {
    const { folder, b } = await twoDevices();
    folder.setAvailability(A, SEGMENT, 'cloud');
    expect((await journal(b)).status).toBe('cloud-pending');
    // Téléchargement de 70 s : au-delà des 60 s par fichier.
    b.testing.setHydrationDelay(70_000);
    await b.scan({ keep: [] });
    expect((await journal(b)).status).toBe('cloud-pending');
    // Téléchargement de 1 s : lu.
    b.testing.setHydrationDelay(1_000);
    await b.scan({ keep: [] });
    expect(await journal(b)).toMatchObject({ status: 'complete', records: ['{"k":"ops","n":1}', '{"k":"ops","n":2}'] });
  });
});

describe('sync_scan({ hydrateBudgetMs }) sur memory.ts (ADR 0011 §22 point 4)', () => {
  it('hors bornes : bad-name ; dans les bornes : accepté', async () => {
    const { b } = await twoDevices();
    for (const bad of [0, -1, 180_001, 1.5, Number.NaN, '25000' as unknown as number]) {
      await expect(b.scan({ keep: [], hydrateBudgetMs: bad })).rejects.toMatchObject({ code: 'bad-name' });
    }
    for (const good of [1, 25_000, 180_000]) await b.scan({ keep: [], hydrateBudgetMs: good });
  });

  it('le budget réduit borne les téléchargements du cycle', async () => {
    const { folder, b } = await twoDevices();
    folder.setAvailability(A, SEGMENT, 'cloud');
    b.testing.setHydrationDelay(30_000);
    await b.scan({ keep: [], hydrateBudgetMs: 20_000 });
    expect((await journal(b)).status).toBe('cloud-pending');
    expect(b.testing.hydrationBudgetLeft()).toBe(0);
    await b.scan({ keep: [] });
    expect(b.testing.hydrationBudgetLeft()).toBe(180_000);
    expect((await journal(b)).status).toBe('complete');
    expect(b.testing.hydrationBudgetLeft()).toBe(150_000);
  });
});
