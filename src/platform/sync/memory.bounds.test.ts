import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../../domain/types';
import {
  FOLDER_STOP_BYTES,
  MAX_APPEND_CALL_BYTES,
  MAX_RECORD_PLAINTEXT_BYTES,
  MAX_SEGMENT_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_STATE_FILE_BYTES,
  NONCE_MAX_RECORDS,
  PAIRING_CLOCK_TOLERANCE_MS,
  SEGMENT_ROTATE_BYTES,
  SYNC_ERROR_CODES,
  encryptedLineBytes,
  epochId,
  publishedStateToJson,
  utf8Bytes,
  type DeviceAck,
  type EpochId,
  type PublishedDeviceState,
} from '../../domain/sync/format';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from './memory';
import { SyncPlatformError } from './types';

/**
 * Compléments QA de l'implémentation mémoire (ADR 0011, sections 1.3, 1.4, 1.6, 9, 10.3, 12) : bornes exactes (limite et limite + 1),
 * curseurs, époques, écrivain unique, appairage hostile, erreurs typées.
 */

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const E1 = epochId(1, A);
const E2A = epochId(2, A);
const E2B = epochId(2, B);
const hlc = (ms: number, dev: string = A): Hlc => `${String(ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const seg = (epoch: EpochId, n: number): string => `${epoch}/j-${String(n).padStart(8, '0')}.ctj`;

let nowMs = 1_800_000_000_000;
const clock = (): number => nowMs;

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof SyncPlatformError ? error.code : `autre : ${String(error)}`;
  }
};

const stateOf = (
  dev: DeviceId,
  epoch: EpochId,
  stateSeq: number,
  head: { segment: number; record: number; hlc: Hlc | null },
  over: Partial<PublishedDeviceState> = {},
): PublishedDeviceState => ({
  deviceId: dev,
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
  lastSyncHlc: hlc(1_000, dev),
  forgotten: [],
  reset: null,
  ...over,
});

const append = (p: MemorySyncPlatform, epoch: EpochId, segment: number, expectRecords: number, maxHlc: Hlc, records: string[]): Promise<unknown> =>
  p.appendJournal({ epoch, segment, expectRecords, sv: 14, maxHlc, records });

async function firstDevice(folder: MemorySyncFolder, id: DeviceId = A): Promise<MemorySyncPlatform> {
  const p = createMemorySyncPlatform({ folder, nowMs: clock });
  await p.folder.choose();
  await p.bindDevice(id);
  await p.key.create();
  return p;
}

async function publish(p: MemorySyncPlatform, dev: DeviceId = A): Promise<void> {
  await append(p, E1, 1, 0, hlc(10, dev), ['{"k":"ops","n":1}']);
  await p.writeState({ sv: 14, state: stateOf(dev, E1, 1, { segment: 1, record: 1, hlc: hlc(10, dev) }) });
}

async function pairByQr(a: MemorySyncPlatform, folder: MemorySyncFolder, id: DeviceId = B): Promise<MemorySyncPlatform> {
  await a.key.openPairing('show');
  const { qrText } = await a.key.pairingPayload();
  await a.key.closePairing();
  const b = createMemorySyncPlatform({ folder, nowMs: clock });
  await b.folder.choose();
  await b.bindDevice(id);
  await b.key.openPairing('import');
  await b.key.import({ qrText });
  return b;
}

const kidOf = async (p: MemorySyncPlatform): Promise<string> => {
  const { kid } = await p.key.status();
  if (!kid) throw new Error('clé attendue');
  return kid;
};
const headerBytes = (h: object): number => utf8Bytes(JSON.stringify(h)) + 1;
const journalHeader = async (p: MemorySyncPlatform, n: number, dev: DeviceId = A, epoch: EpochId = E1): Promise<object> => ({
  f: 'ct-j',
  sm: 1,
  kid: await kidOf(p),
  dev,
  e: epoch,
  n,
});

beforeEach(() => {
  nowMs = 1_800_000_000_000;
});

describe('bornes exactes à l’écriture (section 1.6)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
  });

  it('appel de 1 Mio : la plus grande série acceptée, une ligne de plus : too-large, rien n’est écrit', async () => {
    const line = encryptedLineBytes(utf8Bytes('x'), 1, 14);
    const fit = Math.floor(MAX_APPEND_CALL_BYTES / line);
    expect(fit * line).toBeLessThanOrEqual(MAX_APPEND_CALL_BYTES);
    expect((fit + 1) * line).toBeGreaterThan(MAX_APPEND_CALL_BYTES);
    expect(await codeOf(append(a, E1, 1, 0, hlc(1), Array<string>(fit + 1).fill('x')))).toBe('too-large');
    expect(folder.fileNames(A)).toEqual([]);
    expect(a.testing.sealedRecords()).toBe(0);
    expect(await append(a, E1, 1, 0, hlc(1), Array<string>(fit).fill('x'))).toEqual({ firstRecord: 0, head: { segment: 1, record: fit } });
    expect(a.testing.sealedRecords()).toBe(fit);
  });

  it('enregistrement : 256 Kio octets exactement acceptés (multi-octets compris), un octet de plus refusé', async () => {
    const twoBytes = 'é'.repeat(MAX_RECORD_PLAINTEXT_BYTES / 2);
    expect(utf8Bytes(twoBytes)).toBe(MAX_RECORD_PLAINTEXT_BYTES);
    expect(await codeOf(append(a, E1, 1, 0, hlc(1), [`${twoBytes}x`]))).toBe('too-large');
    expect(await codeOf(append(a, E1, 1, 0, hlc(1), [twoBytes.slice(0, -1) + 'xx']))).toBe('resolved'); // 262 142 + 2 = 262 144 octets exactement
  });

  it('segment à 1 Mio exactement : ajout accepté ; à 1 Mio + 1 octet : segment-full ; segment vide : toujours accepté', async () => {
    await append(a, E1, 1, 0, hlc(1), ['x']);
    const header = await journalHeader(a, 1);
    const line = encryptedLineBytes(1, 1, 14);
    const current = headerBytes(header) + line;
    // Crochet addBytes : la taille du segment après ajout vaut exactement 1 Mio.
    folder.addBytes(A, seg(E1, 1), SEGMENT_ROTATE_BYTES - current - line);
    expect(await append(a, E1, 1, 1, hlc(2), ['y'])).toEqual({ firstRecord: 1, head: { segment: 1, record: 2 } });
    folder.addBytes(A, seg(E1, 1), SEGMENT_ROTATE_BYTES - (headerBytes(header) + 2 * line) - line + 1);
    expect(await codeOf(append(a, E1, 1, 2, hlc(3), ['z']))).toBe('segment-full');
    expect(folder.records(A, seg(E1, 1))).toEqual(['x', 'y']);
    // Segment vide : un enregistrement de 256 Kio passe, même si le segment est gonflé à l'excès.
    expect(await append(a, E1, 2, 0, hlc(4), ['x'.repeat(MAX_RECORD_PLAINTEXT_BYTES)])).toEqual({ firstRecord: 0, head: { segment: 2, record: 1 } });
  });

  it('numéros de segment : 1 et 99 999 999 acceptés, 0 et 100 000 000 refusés (bad-name)', async () => {
    expect(await codeOf(append(a, E1, 0, 0, hlc(1), ['x']))).toBe('bad-name');
    expect(await codeOf(append(a, E1, 100_000_000, 0, hlc(1), ['x']))).toBe('bad-name');
    expect(await codeOf(append(a, E1, 1.5, 0, hlc(1), ['x']))).toBe('bad-name');
    expect(await codeOf(append(a, E1, Number.NaN, 0, hlc(1), ['x']))).toBe('bad-name');
    expect(await append(a, E1, 99_999_999, 0, hlc(1), ['x'])).toEqual({ firstRecord: 0, head: { segment: 99_999_999, record: 1 } });
    expect(folder.fileNames(A)).toEqual([seg(E1, 99_999_999)]);
  });

  it('budget de nonces : NONCE_MAX - 1 laisse écrire un enregistrement, puis key-exhausted ; deux enregistrements dépassent', async () => {
    a.testing.setSealedRecords(NONCE_MAX_RECORDS - 1);
    expect(await codeOf(append(a, E1, 1, 0, hlc(1), ['x', 'y']))).toBe('key-exhausted');
    expect(folder.fileNames(A)).toEqual([]);
    await append(a, E1, 1, 0, hlc(1), ['x']);
    expect(a.testing.sealedRecords()).toBe(NONCE_MAX_RECORDS);
    expect(await codeOf(append(a, E1, 1, 1, hlc(2), ['y']))).toBe('key-exhausted');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 1, record: 1, hlc: hlc(1) }) }))).toBe('key-exhausted');
    expect(await codeOf(a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(['s']) }))).toBe('key-exhausted');
  });

  it('un échec de validation d’un enregistrement du lot n’écrit aucun des précédents', async () => {
    expect(await codeOf(append(a, E1, 1, 0, hlc(1), ['ok', 'x'.repeat(MAX_RECORD_PLAINTEXT_BYTES + 1)]))).toBe('too-large');
    expect(await codeOf(append(a, E1, 1, 0, hlc(1), ['ok', 7 as unknown as string]))).toBe('too-large');
    expect(folder.fileNames(A)).toEqual([]);
    expect(a.testing.sealedRecords()).toBe(0);
  });

  it('paramètres hostiles : records non tableau, expectRecords décimal ou NaN, epoch d’un autre format', async () => {
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: 'abc' as unknown as string[] }))).toBe('bad-name');
    expect(await codeOf(append(a, E1, 1, 0.5, hlc(1), ['x']))).toBe('bad-name');
    expect(await codeOf(append(a, E1, 1, Number.NaN, hlc(1), ['x']))).toBe('bad-name');
    expect(await codeOf(append(a, E1.toUpperCase() as EpochId, 1, 0, hlc(1), ['x']))).toBe('bad-name');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 1.5, maxHlc: hlc(1), records: ['x'] }))).toBe('bad-name');
    expect(folder.fileNames(A)).toEqual([]);
  });

  it('snapshot : 256 Mio exactement acceptés, un enregistrement de plus : too-large et rien n’est publié', async () => {
    const big = 'x'.repeat(MAX_RECORD_PLAINTEXT_BYTES);
    const line = encryptedLineBytes(MAX_RECORD_PLAINTEXT_BYTES, 1, 14);
    const header = { f: 'ct-s', sm: 1, kid: await kidOf(a), dev: A, e: E1, n: 1 };
    const fit = Math.floor((MAX_SNAPSHOT_BYTES - headerBytes(header)) / line);
    expect(headerBytes(header) + (fit + 1) * line).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
    expect(await codeOf(a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(Array<string>(fit + 1).fill(big)) }))).toBe('too-large');
    expect(folder.fileNames(A)).toEqual([]);
    await a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(Array<string>(fit).fill(big)) });
    expect(folder.fileNames(A)).toEqual([`${E1}/s-00000001.cts`]);
  }, 60_000);
});

const pages = (...chunks: string[][]): AsyncIterable<readonly string[]> =>
  (async function* () {
    for (const chunk of chunks) yield await Promise.resolve(chunk);
  })();

describe('bornes exactes à la lecture et au scan (section 1.6)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await publish(a);
  });

  it('dossier : 4 Gio exactement lisible, 4 Gio + 1 octet : folder-too-large', async () => {
    const { totalBytes } = await a.scan({ keep: [] });
    folder.padFolder(FOLDER_STOP_BYTES - totalBytes);
    expect((await a.scan({ keep: [] })).totalBytes).toBe(FOLDER_STOP_BYTES);
    folder.padFolder(1);
    expect(await codeOf(a.scan({ keep: [] }))).toBe('folder-too-large');
    expect(await codeOf(a.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('folder-too-large');
  });

  it('segment : 8 Mio exactement lisible, 8 Mio + 1 octet : too-large', async () => {
    const header = await journalHeader(a, 1);
    const size = headerBytes(header) + encryptedLineBytes(utf8Bytes('{"k":"ops","n":1}'), 1, 14);
    folder.addBytes(A, seg(E1, 1), MAX_SEGMENT_BYTES - size);
    expect((await a.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } })).status).toBe('complete');
    folder.addBytes(A, seg(E1, 1), 1);
    expect(await codeOf(a.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('too-large');
  });

  it('state.ctx : taille maximale exacte acceptée, un octet de plus : too-large (statut du scan et code de lecture)', async () => {
    const text = JSON.stringify(publishedStateToJson(stateOf(A, E1, 1, { segment: 1, record: 1, hlc: hlc(10) })));
    const header = { f: 'ct-state', sm: 1, kid: await kidOf(a), dev: A, e: E1, n: 1 };
    const size = headerBytes(header) + encryptedLineBytes(utf8Bytes(text), 1, 14);
    folder.addBytes(A, 'state.ctx', MAX_STATE_FILE_BYTES - size);
    expect((await a.scan({ keep: [] })).devices[0]?.stateStatus).toBe('ok');
    folder.addBytes(A, 'state.ctx', 1);
    expect((await a.scan({ keep: [] })).devices[0]?.stateStatus).toBe('too-large');
    expect(await codeOf(a.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('too-large');
  });

  it('scan : 10 000 entrées exactement (état compris) : complet ; 10 001 : incomplet', async () => {
    folder.addStrayEntries(A, 9_998); // 1 (state.ctx) + 1 (époque) + 9 998 = 10 000
    expect((await a.scan({ keep: [] })).incomplete).toBe(false);
    folder.addStrayEntries(A, 1);
    expect((await a.scan({ keep: [] })).incomplete).toBe(true);
  });

  // QA-1 corrigé : state.ctx n'est compté que s'il existe.
  it('scan : un dossier d’appareil sans state.ctx et 10 000 entrées exactement n’est pas incomplet', async () => {
    folder.addStrayEntries(B, 10_000);
    expect((await a.scan({ keep: [] })).incomplete).toBe(false);
  });

  it('scan : racine devices/ à 10 000 entrées exactement complète, 10 001 incomplète', async () => {
    folder.addStrayEntries(null, 10_000 - folder.devices.size);
    expect((await a.scan({ keep: [] })).incomplete).toBe(false);
    folder.addStrayEntries(null, 1);
    expect((await a.scan({ keep: [] })).incomplete).toBe(true);
  });

  it('scan : 16 dossiers exactement conservés, 17 : surnombre signalé, son propre dossier gardé', async () => {
    for (let i = 0; i < 14; i += 1) folder.addDeviceFolder(`${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    expect((await a.scan({ keep: [] })).devices).toHaveLength(15);
    folder.addDeviceFolder('ffffffff-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect((await a.scan({ keep: [] })).tooManyDevices).toBe(false);
    folder.addDeviceFolder('fffffffe-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const seventeen = await a.scan({ keep: [] });
    expect(seventeen.tooManyDevices).toBe(true);
    expect(seventeen.devices).toHaveLength(16);
    expect(seventeen.devices.some((d) => d.deviceId === A)).toBe(true);
    expect(seventeen.ignored).toBe(1);
  });
});

describe('curseurs de lecture (sections 1.4, 6)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  const read = (from: { segment: number; record: number }, maxBytes?: number) =>
    a.readJournal({ deviceId: A, epoch: E1, from, ...(maxBytes === undefined ? {} : { maxBytes }) });
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await append(a, E1, 1, 0, hlc(1), ['r0', 'r1']);
    await append(a, E1, 2, 0, hlc(2), ['r2', 'r3', 'r4']);
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 2, record: 3, hlc: hlc(2) }) });
  });

  it('{0,0} et {1,0} lisent tout, de part et d’autre de la rotation, jusqu’à la tête {2,3}', async () => {
    const full = { records: ['r0', 'r1', 'r2', 'r3', 'r4'], next: { segment: 2, record: 3 }, status: 'complete' };
    expect(await read({ segment: 0, record: 0 })).toEqual(full);
    expect(await read({ segment: 1, record: 0 })).toEqual(full);
  });

  it('reprise au milieu : {1,1}, {1,2} (fin du segment 1) et {2,0} rendent la même suite', async () => {
    expect((await read({ segment: 1, record: 1 })).records).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect((await read({ segment: 1, record: 2 })).records).toEqual(['r2', 'r3', 'r4']);
    expect((await read({ segment: 2, record: 0 })).records).toEqual(['r2', 'r3', 'r4']);
    expect(await read({ segment: 2, record: 2 })).toEqual({ records: ['r4'], next: { segment: 2, record: 3 }, status: 'complete' });
  });

  it('curseur sur la tête ou au-delà : rien à lire, curseur inchangé', async () => {
    expect(await read({ segment: 2, record: 3 })).toEqual({ records: [], next: { segment: 2, record: 3 }, status: 'complete' });
    expect(await read({ segment: 2, record: 99 })).toEqual({ records: [], next: { segment: 2, record: 99 }, status: 'complete' });
    expect(await read({ segment: 3, record: 0 })).toEqual({ records: [], next: { segment: 3, record: 0 }, status: 'complete' });
  });

  it('pagination page par page : la suite des curseurs recompose exactement le journal, sans trou ni doublon', async () => {
    const all: string[] = [];
    let from = { segment: 0, record: 0 };
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await read(from, 2);
      all.push(...page.records);
      expect(page.records.length).toBeGreaterThan(0);
      from = page.next;
      if (page.status === 'complete') break;
      expect(page.status).toBe('more');
    }
    expect(all).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(from).toEqual({ segment: 2, record: 3 });
  });

  it('curseurs invalides : segment 0 avec record > 0, négatifs, décimaux, NaN, maxBytes invalide : bad-name', async () => {
    for (const from of [
      { segment: 0, record: 1 },
      { segment: -1, record: 0 },
      { segment: 1, record: -1 },
      { segment: 1.5, record: 0 },
      { segment: 1, record: Number.NaN },
      { segment: 1, record: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(await codeOf(read(from)), JSON.stringify(from)).toBe('bad-name');
    }
    for (const maxBytes of [0, -1, 1.5, Number.NaN]) expect(await codeOf(read({ segment: 0, record: 0 }, maxBytes)), String(maxBytes)).toBe('bad-name');
    expect(await codeOf(a.readJournal({ deviceId: String(A).toUpperCase() as DeviceId, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('bad-name');
  });

  it('segment du milieu manquant : cloud-pending, le curseur reste sur le fichier attendu (jamais sauté)', async () => {
    folder.removeFile(A, seg(E1, 1));
    expect(await read({ segment: 1, record: 0 })).toEqual({ records: [], next: { segment: 1, record: 0 }, status: 'cloud-pending' });
    expect(await read({ segment: 2, record: 1 })).toEqual({ records: ['r3', 'r4'], next: { segment: 2, record: 3 }, status: 'complete' });
  });

  it('un enregistrement corrompu arrête la page : les précédents sont rendus, le curseur désigne le fautif', async () => {
    folder.corruptRecord(A, seg(E1, 2), 1);
    expect(await read({ segment: 0, record: 0 })).toEqual({ records: ['r0', 'r1', 'r2'], next: { segment: 2, record: 1 }, status: 'truncated' });
    expect(await read({ segment: 2, record: 1 })).toEqual({ records: [], next: { segment: 2, record: 1 }, status: 'truncated' });
  });
});

describe('époques (section 9)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await publish(a);
  });

  it('même numéro, ouvreur plus grand : accepté ; ouvreur plus petit ensuite : refusé (ordre numéro puis UUID)', async () => {
    await a.writeState({ sv: 14, state: stateOf(A, E2B, 2, { segment: 0, record: 0, hlc: null }) });
    expect(await codeOf(append(a, E2A, 1, 0, hlc(50), ['x']))).toBe('state-mismatch');
    expect(await codeOf(append(a, E1, 2, 0, hlc(50), ['x']))).toBe('state-mismatch');
    await append(a, E2B, 1, 0, hlc(5), ['x']);
  });

  it('même numéro, ouvreur plus petit puis plus grand : la montée est acceptée', async () => {
    await a.writeState({ sv: 14, state: stateOf(A, E2A, 2, { segment: 0, record: 0, hlc: null }) });
    await append(a, E2B, 1, 0, hlc(5), ['x']);
    expect(folder.fileNames(A)).toContain(seg(E2B, 1));
  });

  it('le scan liste les époques dans l’ordre (numéro, puis UUID) avec leurs segments triés', async () => {
    await a.writeState({ sv: 14, state: stateOf(A, E2B, 2, { segment: 0, record: 0, hlc: null }) });
    await append(a, E2B, 1, 0, hlc(5), ['x']);
    await append(a, E2B, 2, 0, hlc(7), ['y']);
    const [device] = (await a.scan({ keep: [] })).devices;
    expect(device?.epochs.map((e) => e.epoch)).toEqual([E1, E2B]);
    expect(device?.epochs[1]?.segments).toEqual([1, 2]);
  });

  it('suppression : l’époque courante et le segment de tête sont protégés ; l’ancienne époque part entière', async () => {
    await a.writeState({ sv: 14, state: stateOf(A, E2A, 2, { segment: 0, record: 0, hlc: null }) });
    expect(await a.deleteOwn([{ epoch: E1, kind: 'epoch' }])).toBe(1);
    expect(await codeOf(a.deleteOwn([{ epoch: E2A, kind: 'epoch' }]))).toBe('current-epoch');
    expect(folder.fileNames(A)).toEqual(['state.ctx']);
  });

  it('suppression atomique : une référence invalide dans la liste n’en supprime aucune', async () => {
    await append(a, E1, 2, 1, hlc(20), ['y']).catch(() => undefined);
    await append(a, E1, 2, 0, hlc(21), ['y']);
    const before = folder.fileNames(A);
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }, { epoch: E1, kind: 'j' }]))).toBe('bad-name');
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }, { epoch: E1, kind: 'epoch', n: 1 }]))).toBe('bad-name');
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }, { epoch: E1, kind: 'x' as 'j', n: 1 }]))).toBe('bad-name');
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }, { epoch: E1, kind: 'j', n: 2 }]))).toBe('current-epoch');
    expect(folder.fileNames(A)).toEqual(before);
    expect(await a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }, { epoch: E1, kind: 'j', n: 1 }])).toBe(1);
  });
});

describe('écrivain unique et isolation des appareils (sections 1.1, 1.4)', () => {
  it('B écrit dans son dossier seulement ; il ne peut ni publier l’état de A, ni supprimer ses fichiers', async () => {
    const folder = new MemorySyncFolder();
    const a = await firstDevice(folder);
    await publish(a);
    const b = await pairByQr(a, folder);
    const filesOfA = folder.fileNames(A);
    await append(b, E1, 1, 0, hlc(30, B), ['b0']);
    expect(folder.fileNames(A)).toEqual(filesOfA);
    expect(folder.fileNames(B)).toEqual([seg(E1, 1)]);
    expect(await codeOf(b.writeState({ sv: 14, state: stateOf(A, E1, 5, { segment: 1, record: 1, hlc: hlc(30, B) }, { pairedBy: A }) }))).toBe('state-mismatch');
    await b.deleteOwn([{ epoch: E1, kind: 'epoch' }]).catch(() => undefined);
    expect(folder.fileNames(A)).toEqual(filesOfA);
    expect(await b.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } })).toMatchObject({ records: ['{"k":"ops","n":1}'], status: 'complete' });
  });

  it('deux instances liées au même appareil : la seconde ne peut écrire sur un segment que la première a fait avancer (expectRecords)', async () => {
    const folder = new MemorySyncFolder();
    const a1 = await firstDevice(folder);
    await publish(a1);
    const a2 = await pairByQr(a1, folder, A);
    expect(await codeOf(append(a2, E1, 1, 0, hlc(99), ['intrus']))).toBe('segment-mismatch');
    await append(a1, E1, 1, 1, hlc(11), ['r1']);
    expect(await codeOf(append(a2, E1, 1, 1, hlc(12), ['intrus']))).not.toBe('resolved'); // own.json de a2 déjà reconstruit : tête = 1
    expect(folder.records(A, seg(E1, 1))).toEqual(['{"k":"ops","n":1}', 'r1']);
  });

  it('un tiers qui remplace le segment par un fichier d’un autre appareil ou d’une autre clé est refusé en lecture', async () => {
    const folder = new MemorySyncFolder();
    const a = await firstDevice(folder);
    await publish(a);
    const other = new MemorySyncFolder();
    const stranger = await firstDevice(other, B);
    await publish(stranger, B);
    // Même nom de dossier d'appareil, clé différente : la tête de l'état est « foreign ».
    const state = other.takeState(B);
    folder.putState({ deviceId: A, file: state.file });
    expect(await codeOf(a.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('key-mismatch');
    expect((await a.scan({ keep: [] })).devices.find((d) => d.deviceId === A)?.stateStatus).toBe('foreign');
  });
});

describe('appairage hostile (sections 2 et 10.3)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  let qr: string;
  const decode = (text: string): string => {
    const b64 = text.slice('CTPAIR1.'.length).replace(/-/g, '+').replace(/_/g, '/');
    return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  };
  const encode = (json: string): string => `CTPAIR1.${btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
  const importer = async (): Promise<MemorySyncPlatform> => {
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    await b.folder.choose();
    await b.key.openPairing('import');
    return b;
  };
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await publish(a);
    await a.key.openPairing('show');
    qr = (await a.key.pairingPayload()).qrText;
  });

  it('expiration : exactement x + 2 min acceptée', async () => {
    const x = Number((JSON.parse(decode(qr)) as { x: number }).x);
    nowMs = x + PAIRING_CLOCK_TOLERANCE_MS;
    const b = await importer();
    expect((await b.key.import({ qrText: qr })).pairedBy).toBe(A);
  });

  it('QR hostiles : clé en trop, clé manquante, v différent, clé de mauvaise taille, x décimal, texte trop long : invalid-pairing, rien n’est enregistré', async () => {
    const good = JSON.parse(decode(qr)) as Record<string, unknown>;
    const variants: Record<string, string> = {
      'clé en trop': JSON.stringify({ ...good, extra: 1 }),
      'clé manquante': JSON.stringify({ v: good['v'], k: good['k'], d: good['d'], e: good['e'] }),
      'v=2': JSON.stringify({ ...good, v: 2 }),
      'v=1.0 texte': JSON.stringify(good).replace('"v":1', '"v":"1"'),
      'k court': JSON.stringify({ ...good, k: 'AAAA' }),
      'd invalide': JSON.stringify({ ...good, d: 'pc' }),
      'x décimal': JSON.stringify({ ...good, x: 1.5 }),
      'x texte': JSON.stringify({ ...good, x: '1' }),
      'e invalide': JSON.stringify({ ...good, e: 'e1' }),
      'tableau': JSON.stringify([good]),
      'proto': JSON.stringify(good).replace('{', '{"__proto__":{"a":1},'),
    };
    for (const [name, json] of Object.entries(variants)) {
      const b = await importer();
      expect(await codeOf(b.key.import({ qrText: encode(json) })), name).toBe('invalid-pairing');
      expect((await b.key.status()).present, name).toBe(false);
      nowMs += 11 * 60_000; // hors du blocage et de la fenêtre de limitation
    }
    const b = await importer();
    expect(await codeOf(b.key.import({ qrText: `CTPAIR1.${'A'.repeat(1100)}` })), 'trop long').toBe('invalid-pairing');
    expect(await codeOf(b.key.import({ qrText: qr.replace('CTPAIR1.', 'CTPAIR2.') }))).toBe('invalid-pairing');
  });

  // QA-2 corrigé : clé répétée refusée comme le fait serde (analyse lexicale partagée avec parseFileHeader).
  it('clé répétée dans le JSON du QR : refusée comme le fait serde (deny_unknown_fields, doublons)', async () => {
    const duplicated = decode(qr).replace('{', '{"v":1,');
    const b = await importer();
    expect(await codeOf(b.key.import({ qrText: encode(duplicated) }))).toBe('invalid-pairing');
  });

  it('la clé de secours : mauvaise longueur, caractère hors alphabet, texte vide, types hostiles : invalid-pairing', async () => {
    const { recoveryKey } = await a.key.pairingPayload({ renew: true });
    for (const bad of ['', 'CT1-', recoveryKey.slice(0, -1), `${recoveryKey}0`, recoveryKey.replace(/.$/, 'U'), 42 as unknown as string]) {
      const fresh = await importer();
      expect(await codeOf(fresh.key.import({ recoveryKey: bad })), String(bad)).toBe('invalid-pairing');
    }
    const b = await importer();
    expect(await codeOf(b.key.import({ recoveryKey: recoveryKey.toLowerCase().replace(/-/g, ' ') }))).toBe('resolved');
  });
});

describe('erreurs typées', () => {
  it('toutes les erreurs levées par la plateforme sont des SyncPlatformError dont le code figure dans les 35 codes', async () => {
    const folder = new MemorySyncFolder();
    const p = createMemorySyncPlatform({ folder, nowMs: clock });
    const failures: Promise<unknown>[] = [
      p.scan({ keep: [] }),
      p.bindDevice(A),
      p.key.create(),
      p.key.openPairing('show'),
      p.key.pairingPayload(),
      p.key.import({ qrText: 'x' }),
      p.key.closePairing(),
      p.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } }),
      p.readSnapshot({ deviceId: A, epoch: E1, seq: 1, fromRecord: 0 }),
      append(p, E1, 1, 0, hlc(1), ['x']),
      p.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 0, record: 0, hlc: null }) }),
      p.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(['x']) }),
      p.deleteOwn([{ epoch: E1, kind: 'epoch' }]),
    ];
    for (const failure of failures) {
      const error = await failure.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SyncPlatformError);
      expect(SYNC_ERROR_CODES).toContain((error as SyncPlatformError).code);
    }
  });

  it('coffre indisponible : lecture, écriture et appairage refusés avec vault-unavailable', async () => {
    const folder = new MemorySyncFolder();
    const a = await firstDevice(folder);
    await publish(a);
    a.testing.setVaultAvailable(false);
    expect(await codeOf(a.scan({ keep: [] }))).toBe('vault-unavailable');
    expect(await codeOf(append(a, E1, 1, 1, hlc(20), ['x']))).toBe('vault-unavailable');
    expect(await codeOf(a.key.openPairing('show'))).toBe('vault-unavailable');
    expect(await codeOf(a.key.import({ recoveryKey: 'x' }))).not.toBe('resolved');
  });
});
