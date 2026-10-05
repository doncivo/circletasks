import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceId, Hlc, IsoDateTime } from '../../domain/types';
import {
  CONSENT_BLOCK_MS,
  CONSENT_WINDOW_MS,
  FOLDER_STOP_BYTES,
  MAX_RECORD_PLAINTEXT_BYTES,
  NONCE_MAX_RECORDS,
  PAIRING_CLOCK_TOLERANCE_MS,
  PAIRING_VALIDITY_MS,
  epochId,
  type DeviceAck,
  type EpochId,
  type PublishedDeviceState,
} from '../../domain/sync/format';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from './memory';
import { SyncPlatformError, type RestoreMarker } from './types';

/** Implémentation mémoire de `SyncPlatform` (ADR 0011, sections 1, 2, 10.3 et 11) : contrats, bornes et codes d'erreur de Rust. */

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const C = '9b2f4c1e-3d5a-4e6b-8c7d-1a2b3c4d5e6f' as DeviceId;
const E1 = epochId(1, A);
const E2 = epochId(2, A);
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

/** Premier appareil : dossier, liaison, clé. */
async function firstDevice(folder: MemorySyncFolder, id: DeviceId = A): Promise<MemorySyncPlatform> {
  const p = createMemorySyncPlatform({ folder, nowMs: clock });
  await p.folder.choose();
  await p.bindDevice(id);
  await p.key.create();
  return p;
}

/** A publie un enregistrement et son état (le dossier porte alors son `kid`). */
async function publish(p: MemorySyncPlatform, dev: DeviceId = A): Promise<void> {
  await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10, dev), records: ['{"k":"ops","n":1}'] });
  await p.writeState({ sv: 14, state: stateOf(dev, E1, 1, { segment: 1, record: 1, hlc: hlc(10, dev) }) });
}

/** Second appareil associé par le QR du premier (fenêtre `pairing`, mode `import`). */
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

beforeEach(() => {
  nowMs = 1_800_000_000_000;
});

describe('dossier et liaison (Y-01)', () => {
  it('non configuré, choix, annulation, oubli', async () => {
    const folder = new MemorySyncFolder();
    const p = createMemorySyncPlatform({ folder, nowMs: clock });
    expect(p.available()).toBe(true);
    expect(await p.folder.info()).toEqual({ configured: false, label: null, kind: 'unknown', pinned: false });
    expect(await codeOf(p.scan({ keep: [] }))).toBe('not-configured');
    expect(await codeOf(p.bindDevice(A))).toBe('not-configured');
    expect(await p.folder.choose()).toEqual({ configured: true, label: 'iCloud Drive / CircleTasks', kind: 'icloud', pinned: true });
    p.testing.setChooser(null);
    expect(await p.folder.choose()).toBeNull();
    expect((await p.folder.info()).configured).toBe(true);
    await p.folder.forget({ eraseKey: false });
    expect((await p.folder.info()).configured).toBe(false);
    expect(createMemorySyncPlatform({ available: false }).available()).toBe(false);
  });

  it('liaison figée tant que le dossier n’est pas oublié (audit B5)', async () => {
    const p = createMemorySyncPlatform({ folder: new MemorySyncFolder(), nowMs: clock });
    await p.folder.choose();
    expect(await codeOf(p.bindDevice('pc' as DeviceId))).toBe('bad-name');
    await p.bindDevice(A);
    await p.bindDevice(A);
    expect(await codeOf(p.bindDevice(B))).toBe('already-bound');
    await p.folder.forget({ eraseKey: false });
    await p.folder.choose();
    await p.bindDevice(B);
  });

  it('écrire sans liaison : not-bound', async () => {
    const p = createMemorySyncPlatform({ folder: new MemorySyncFolder(), nowMs: clock });
    await p.folder.choose();
    await p.key.create();
    expect(await codeOf(p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'] }))).toBe('not-bound');
  });
});

describe('clé (Y-08)', () => {
  it('création, kid de 16 hexa, key-exists, coffre indisponible', async () => {
    const p = createMemorySyncPlatform({ folder: new MemorySyncFolder(), nowMs: clock });
    expect(await codeOf(p.key.create())).toBe('not-configured');
    await p.folder.choose();
    expect(await p.key.status()).toEqual({ present: false, kid: null });
    const { kid } = await p.key.create();
    expect(kid).toMatch(/^[0-9a-f]{16}$/);
    expect(await p.key.status()).toEqual({ present: true, kid });
    expect(await codeOf(p.key.create())).toBe('key-exists');
    p.testing.setVaultAvailable(false);
    expect(await codeOf(p.key.status())).toBe('vault-unavailable');
  });

  it('refuse de créer une clé dans un dossier qui contient des données (second audit, point 13)', async () => {
    const folder = new MemorySyncFolder();
    await publish(await firstDevice(folder));
    const other = createMemorySyncPlatform({ folder, nowMs: clock });
    await other.folder.choose();
    expect(await codeOf(other.key.create())).toBe('folder-has-data');
    expect((await other.key.status()).present).toBe(false);
  });

  it('oublier le dossier et la clé : confirmation native, refus sans effet', async () => {
    const p = await firstDevice(new MemorySyncFolder());
    p.testing.setConsent(false);
    expect(await codeOf(p.folder.forget({ eraseKey: true }))).toBe('consent-denied');
    expect((await p.key.status()).present).toBe(true);
    expect((await p.folder.info()).configured).toBe(true);
    nowMs += CONSENT_BLOCK_MS;
    p.testing.setConsent(true);
    await p.folder.forget({ eraseKey: true });
    expect((await p.key.status()).present).toBe(false);
  });
});

describe('ajout au journal (sections 1.3, 1.4)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
  });

  it('firstRecord calculé par Rust, tête rendue', async () => {
    expect(await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(2), records: ['r0', 'r1'] })).toEqual({ firstRecord: 0, head: { segment: 1, record: 2 } });
    expect(await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 2, sv: 14, maxHlc: hlc(3), records: ['r2'] })).toEqual({ firstRecord: 2, head: { segment: 1, record: 3 } });
    expect(folder.records(A, seg(E1, 1))).toEqual(['r0', 'r1', 'r2']);
    expect(a.testing.sealedRecords()).toBe(3);
  });

  it('segment-mismatch : nombre attendu différent, ligne incomplète, numéro repris en arrière', async () => {
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(2), records: ['r0'] });
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(3), records: ['x'] }))).toBe('segment-mismatch');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 2, expectRecords: 1, sv: 14, maxHlc: hlc(3), records: ['x'] }))).toBe('segment-mismatch');
    folder.setPartialTail(A, seg(E1, 1), true);
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(3), records: ['x'] }))).toBe('segment-mismatch');
    await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(3), records: ['r1'] });
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(4), records: ['x'] }))).toBe('segment-mismatch');
  });

  it('hlc-order : maxHlc strictement croissant dans une époque, contrôle remis à zéro à la suivante', async () => {
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['r0'] });
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(10), records: ['x'] }))).toBe('hlc-order');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(9), records: ['x'] }))).toBe('hlc-order');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: 'x' as Hlc, records: ['x'] }))).toBe('bad-name');
    expect(await a.appendJournal({ epoch: E2, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(5), records: ['report'] })).toEqual({ firstRecord: 0, head: { segment: 1, record: 1 } });
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(50), records: ['x'] }))).toBe('state-mismatch');
  });

  it('bornes : 256 Kio par enregistrement, 1 Mio par appel, segment plein sauf s’il est vide', async () => {
    const big = 'x'.repeat(200 * 1024);
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'.repeat(MAX_RECORD_PLAINTEXT_BYTES + 1)] }))).toBe('too-large');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: [big, big, big, big] }))).toBe('too-large');
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: [big, big, big] });
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 3, sv: 14, maxHlc: hlc(2), records: [big] }))).toBe('segment-full');
    expect(await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(2), records: ['x'.repeat(MAX_RECORD_PLAINTEXT_BYTES)] })).toEqual({ firstRecord: 0, head: { segment: 2, record: 1 } });
  });

  it('paramètres invalides et appel vide refusés, rien n’est écrit', async () => {
    expect(await codeOf(a.appendJournal({ epoch: 'e1' as EpochId, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'] }))).toBe('bad-name');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 0, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'] }))).toBe('bad-name');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: -1, sv: 14, maxHlc: hlc(1), records: ['x'] }))).toBe('bad-name');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 0, maxHlc: hlc(1), records: ['x'] }))).toBe('bad-name');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: [] }))).toBe('bad-name');
    expect(folder.fileNames(A)).toEqual([]);
  });

  it('budget de nonces épuisé : key-exhausted (audit B1)', async () => {
    a.testing.setSealedRecords(NONCE_MAX_RECORDS);
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'] }))).toBe('key-exhausted');
  });

  it('own.json perdu : reconstruit depuis son state.ctx et ses fichiers (règle 1)', async () => {
    await publish(a);
    a.testing.dropOwnState();
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['x'] }))).toBe('segment-mismatch');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(10), records: ['x'] }))).toBe('hlc-order');
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(20), records: ['r1'] });
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 1, record: 2, hlc: hlc(20) }) }))).toBe('state-mismatch');
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 1, record: 2, hlc: hlc(20) }) });
  });

  it('state.ctx supprimé, segments présents, accusé de B sur A : hlc-order toujours appliqué', async () => {
    await publish(a);
    const b = await pairByQr(a, folder);
    await b.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1, B), records: ['b0'] });
    const ackOfA = { epoch: E1, segment: 1, record: 1, hlc: hlc(10), stateSeq: 1 };
    await b.writeState({ sv: 14, state: stateOf(B, E1, 1, { segment: 1, record: 1, hlc: hlc(1, B) }, { pairedBy: A, acks: new Map([[A, ackOfA]]) }) });
    folder.removeFile(A, 'state.ctx');
    a.testing.dropOwnState();
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(5), records: ['x'] }))).toBe('hlc-order');
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(10), records: ['x'] }))).toBe('hlc-order');
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(11), records: ['r1'] });
    // stateSeq : au moins celui que B a accusé
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 1, record: 2, hlc: hlc(11) }) }))).toBe('state-mismatch');
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 1, record: 2, hlc: hlc(11) }) });
  });

  it('segment de tête tronqué ou disparu : jamais d’index réutilisé, le segment suivant débloque (règle 1)', async () => {
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['r0', 'r1', 'r2'] });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 1, record: 3, hlc: hlc(10) }) });
    folder.removeFile(A, seg(E1, 1));
    a.testing.dropOwnState();
    expect(await codeOf(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(11), records: ['x'] }))).toBe('segment-mismatch');
    expect(await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(11), records: ['r3'] })).toEqual({ firstRecord: 0, head: { segment: 2, record: 1 } });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 2, record: 1, hlc: hlc(11) }) });
  });

  it('un autre dossier remet own.json à zéro (section 1.4)', async () => {
    await publish(a);
    a.testing.setChooser(new MemorySyncFolder('autre'));
    await a.folder.choose();
    expect(await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'] })).toEqual({ firstRecord: 0, head: { segment: 1, record: 1 } });
  });
});

describe('écriture de state.ctx (section 1.4, second audit point 6)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(10), records: ['r0'] });
  });
  const head = { segment: 1, record: 1, hlc: hlc(10) };

  it('nominal : relu par scan, accusés en Map', async () => {
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { acks: new Map([[B, { epoch: E1, segment: 1, record: 0, hlc: null, stateSeq: 1 }]]) }) });
    const scan = await a.scan({ keep: [] });
    expect(scan.devices).toHaveLength(1);
    expect(scan.devices[0]?.stateStatus).toBe('ok');
    expect(scan.devices[0]?.state?.acks.get(B)?.stateSeq).toBe(1);
    expect(scan.devices[0]?.epochs).toEqual([{ epoch: E1, segments: [1], snapshots: [] }]);
    expect(folder.fileNames(A)).toEqual([seg(E1, 1), 'state.ctx']);
  });

  it('tête différente de own.json, stateSeq qui ne croît pas : state-mismatch', async () => {
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, { ...head, record: 2 }) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, { ...head, hlc: hlc(11) }) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, { ...head, segment: 2 }) }))).toBe('state-mismatch');
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, head) });
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head) }))).toBe('state-mismatch');
  });

  it('identité, version, pairedBy, forgotten et reset contrôlés', async () => {
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(B, E1, 1, head) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 15, state: stateOf(A, E1, 1, head) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { platform: 'ios' }) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { pairedBy: B }) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { forgotten: [{ deviceId: B, at: hlc(1), lastAck: null }] }) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { reset: { kid: '0123456789abcdef', epoch: E2, at: hlc(2) } }) }))).toBe('state-mismatch');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { lastSyncHlc: 'x' as Hlc }) }))).toBe('bad-name');
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { sm: 0 }) }))).toBe('bad-name');
  });

  it('plus de 64 accusés : too-large', async () => {
    const acks = new Map(Array.from({ length: 65 }, (_, i) => [`${String(i).padStart(8, '0')}-d9cb-469f-a165-70867728950e` as DeviceId, { epoch: E1, segment: 1, record: 0, hlc: null, stateSeq: 1 }] as const));
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E1, 1, head, { acks }) }))).toBe('too-large');
  });

  it('stateSeq croît sur toute la vie de l’appareil : une nouvelle époque qui repart à 1 est refusée', async () => {
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, head) });
    const empty = { segment: 0, record: 0, hlc: null };
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E2, 1, empty) }))).toBe('state-mismatch');
    await a.writeState({ sv: 14, state: stateOf(A, E2, 2, empty) });
    a.testing.dropOwnState();
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E2, 2, empty) }))).toBe('state-mismatch');
  });

  it('nouvelle époque annoncée avant tout ajout : tête vide exigée', async () => {
    expect(await codeOf(a.writeState({ sv: 14, state: stateOf(A, E2, 1, head) }))).toBe('state-mismatch');
    await a.writeState({ sv: 14, state: stateOf(A, E2, 1, { segment: 0, record: 0, hlc: null }) });
    expect(await a.appendJournal({ epoch: E2, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(3), records: ['x'] })).toEqual({ firstRecord: 0, head: { segment: 1, record: 1 } });
  });
});

describe('appairage (Y-06, sections 2.1 et 10.3)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await publish(a);
  });

  it('QR : la clé passe, pairedBy et époque rendus, fenêtre détruite', async () => {
    await a.key.openPairing('show');
    const payload = await a.key.pairingPayload();
    expect(payload.qrText.startsWith('CTPAIR1.')).toBe(true);
    expect(payload.recoveryKey).toMatch(/^CT1-([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(payload.expiresAt).toBe(nowMs + PAIRING_VALIDITY_MS);
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    await b.folder.choose();
    await b.key.openPairing('import');
    const result = await b.key.import({ qrText: payload.qrText });
    expect(result).toEqual({ kid: (await a.key.status()).kid, pairedBy: A, epoch: E1 });
    expect(b.testing.pairing()).toBeNull();
    await b.bindDevice(B);
    await b.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1, B), records: ['b0'] });
    // pairedBy mémorisé à l'import : Rust en est le maître.
    expect(await codeOf(b.writeState({ sv: 14, state: stateOf(B, E1, 1, { segment: 1, record: 1, hlc: hlc(1, B) }) }))).toBe('state-mismatch');
    await b.writeState({ sv: 14, state: stateOf(B, E1, 1, { segment: 1, record: 1, hlc: hlc(1, B) }, { pairedBy: A }) });
  });

  it('clé de secours : saisie tolérante, somme de contrôle vérifiée', async () => {
    await a.key.openPairing('show');
    const { recoveryKey } = await a.key.pairingPayload();
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    await b.folder.choose();
    await b.key.openPairing('import');
    const swap = (text: string, at: number): string => text.slice(0, at) + (text[at] === '2' ? '3' : '2') + text.slice(at + 1);
    expect(await codeOf(b.key.import({ recoveryKey: swap(recoveryKey, recoveryKey.length - 1) }))).toBe('invalid-pairing'); // bits de remplissage
    expect(await codeOf(b.key.import({ recoveryKey: swap(recoveryKey, 6) }))).toBe('invalid-pairing'); // somme de contrôle
    expect(await codeOf(b.key.import({ recoveryKey: recoveryKey.slice(0, -2) }))).toBe('invalid-pairing');
    const messy = ` ${recoveryKey.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    expect(await b.key.import({ recoveryKey: messy })).toEqual({ kid: (await a.key.status()).kid, pairedBy: null, epoch: null });
  });

  it('fenêtres et modes : wrong-window, wrong-mode, libellé déjà pris', async () => {
    expect(await codeOf(a.key.pairingPayload())).toBe('wrong-window');
    expect(await codeOf(a.key.closePairing())).toBe('wrong-window');
    await a.key.openPairing('show');
    expect(await codeOf(a.key.openPairing('show'))).toBe('consent-denied');
    expect(await codeOf(a.key.import({ recoveryKey: 'CT1-x' }))).toBe('wrong-mode');
    await a.key.pairingPayload();
    expect(await codeOf(a.key.pairingPayload())).toBe('wrong-window'); // jeton à usage unique
    await a.key.closePairing();
    await a.key.openPairing('import');
    expect(await codeOf(a.key.pairingPayload())).toBe('wrong-mode');
    expect(await codeOf(a.key.pairingPayload({ renew: true }))).toBe('wrong-mode');
    expect(a.testing.consentPrompts()).toBe(1);
  });

  it('Nouveau code : nouvelle confirmation, nouvelle génération ; 3 affichages par 10 minutes', async () => {
    await a.key.openPairing('show');
    await a.key.pairingPayload();
    await a.key.pairingPayload({ renew: true });
    expect(a.testing.pairing()).toEqual({ mode: 'show', generation: 2 });
    await a.key.pairingPayload({ renew: true });
    expect(await codeOf(a.key.pairingPayload({ renew: true }))).toBe('rate-limited');
    expect(a.testing.consentPrompts()).toBe(3);
    nowMs += CONSENT_WINDOW_MS;
    expect(a.testing.pairing()).toBeNull(); // fenêtre expirée au bout de 5 minutes
    await a.key.openPairing('show');
  });

  it('refus : consent-denied, puis 10 minutes de blocage ; fenêtre au second plan : aucune boîte', async () => {
    a.testing.setConsent(false);
    expect(await codeOf(a.key.openPairing('show'))).toBe('consent-denied');
    expect(a.testing.pairing()).toBeNull();
    a.testing.setConsent(true);
    expect(await codeOf(a.key.openPairing('show'))).toBe('rate-limited');
    nowMs += CONSENT_BLOCK_MS;
    a.testing.setForeground(false);
    expect(await codeOf(a.key.openPairing('show'))).toBe('consent-denied');
    expect(a.testing.consentPrompts()).toBe(1);
    a.testing.setForeground(true);
    await a.key.openPairing('show');
  });

  it('QR expiré (au-delà de x + 2 min), illisible, ou d’une autre clé', async () => {
    await a.key.openPairing('show');
    const { qrText, expiresAt } = await a.key.pairingPayload();
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    await b.folder.choose();
    await b.key.openPairing('import');
    expect(await codeOf(b.key.import({ qrText: 'CTPAIR1.e30' }))).toBe('invalid-pairing');
    expect(await codeOf(b.key.import({ qrText: 'n’importe quoi' }))).toBe('invalid-pairing');
    nowMs = expiresAt + PAIRING_CLOCK_TOLERANCE_MS + 1;
    // la fenêtre `import` a expiré avec le temps : on en rouvre une
    await b.key.openPairing('import');
    expect(await codeOf(b.key.import({ qrText }))).toBe('pairing-expired');
    const other = await firstDevice(new MemorySyncFolder('autre'), C);
    await other.key.openPairing('show');
    const foreign = await other.key.pairingPayload();
    expect(await codeOf(b.key.import({ qrText: foreign.qrText }))).toBe('cloud-pending'); // C n'a rien dans ce dossier
    expect((await b.key.status()).present).toBe(false);
  });

  it('clé absente du dossier : key-mismatch, rien n’est enregistré (audit B3)', async () => {
    const other = await firstDevice(new MemorySyncFolder('autre'), C);
    await other.key.openPairing('show');
    const { recoveryKey } = await other.key.pairingPayload();
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    await b.folder.choose();
    await b.key.openPairing('import');
    expect(await codeOf(b.key.import({ recoveryKey }))).toBe('key-mismatch');
    expect((await b.key.status()).present).toBe(false);
  });

  it('dossier sans état lisible : cloud-pending ; 5 imports par 10 minutes', async () => {
    folder.setAvailability(A, 'state.ctx', 'cloud');
    await a.key.openPairing('show');
    const { recoveryKey } = await a.key.pairingPayload();
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    expect(await codeOf(b.key.openPairing('import'))).toBe('not-configured');
    await b.folder.choose();
    await b.key.openPairing('import');
    for (let i = 0; i < 5; i += 1) expect(await codeOf(b.key.import({ recoveryKey }))).toBe('cloud-pending');
    expect(await codeOf(b.key.import({ recoveryKey }))).toBe('rate-limited');
  });

  it('remplacer une autre clé demande une confirmation ; la même clé est sans effet', async () => {
    await a.key.openPairing('show');
    const { recoveryKey } = await a.key.pairingPayload();
    const b = createMemorySyncPlatform({ folder: new MemorySyncFolder('b'), nowMs: clock });
    await b.folder.choose();
    const own = await b.key.create();
    b.testing.setChooser(folder);
    await b.folder.choose();
    await b.key.openPairing('import');
    b.testing.setConsent(false);
    expect(await codeOf(b.key.import({ recoveryKey }))).toBe('consent-denied');
    expect((await b.key.status()).kid).toBe(own.kid);
    nowMs += CONSENT_BLOCK_MS;
    b.testing.setConsent(true);
    b.testing.setSealedRecords(5);
    await b.key.openPairing('import');
    await b.key.import({ recoveryKey });
    expect((await b.key.status()).kid).toBe((await a.key.status()).kid);
    expect(b.testing.sealedRecords()).toBe(0); // budget de nonces compté par clé
    await b.key.openPairing('import');
    await b.key.import({ recoveryKey });
    expect(b.testing.consentPrompts()).toBe(2);
  });

  it('le message d’erreur ne recopie jamais l’entrée (section 2.1)', async () => {
    const b = createMemorySyncPlatform({ folder, nowMs: clock });
    await b.folder.choose();
    await b.key.openPairing('import');
    const secret = 'CT1-SECRE-TSECR-ETSEC';
    try {
      await b.key.import({ recoveryKey: secret });
      throw new Error('rejet attendu');
    } catch (error) {
      expect(error).toBeInstanceOf(SyncPlatformError);
      expect(String((error as Error).message)).not.toContain('SECRE');
    }
  });

  it('iPhone : pas de fenêtre pairing, scan lancé par Rust ; le PC refuse le scan', async () => {
    await a.key.openPairing('show');
    const { qrText } = await a.key.pairingPayload();
    const phone = createMemorySyncPlatform({ folder, platform: 'ios', nowMs: clock });
    await phone.folder.choose();
    expect(await codeOf(phone.key.openPairing('show'))).toBe('wrong-window');
    expect(await codeOf(phone.key.import({ scan: true }))).toBe('consent-denied'); // scan annulé
    phone.testing.setScanResult(qrText);
    expect((await phone.key.import({ scan: true })).pairedBy).toBe(A);
    const pc = createMemorySyncPlatform({ folder, nowMs: clock });
    await pc.folder.choose();
    await pc.key.openPairing('import');
    expect(await codeOf(pc.key.import({ scan: true }))).toBe('invalid-pairing');
  });
});

describe('lecture des journaux (sections 1.2, 1.4, 6)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  let b: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(2), records: ['a0', 'a1'] });
    await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(3), records: ['a2'] });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 2, record: 1, hlc: hlc(3) }) });
    b = await pairByQr(a, folder);
  });
  const fromStart = { deviceId: A, epoch: E1, from: { segment: 0, record: 0 } };

  it('lit jusqu’à la tête authentifiée, jamais au-delà', async () => {
    expect(await b.readJournal(fromStart)).toEqual({ records: ['a0', 'a1', 'a2'], next: { segment: 2, record: 1 }, status: 'complete' });
    await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 1, sv: 14, maxHlc: hlc(4), records: ['a3'] });
    expect(await b.readJournal({ ...fromStart, from: { segment: 2, record: 1 } })).toEqual({ records: [], next: { segment: 2, record: 1 }, status: 'complete' });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 2, record: 2, hlc: hlc(4) }) });
    expect((await b.readJournal({ ...fromStart, from: { segment: 2, record: 1 } })).records).toEqual(['a3']);
  });

  it('pages bornées par maxBytes (au moins un enregistrement par page)', async () => {
    const first = await b.readJournal({ ...fromStart, maxBytes: 3 });
    expect(first).toEqual({ records: ['a0'], next: { segment: 1, record: 1 }, status: 'more' });
    const second = await b.readJournal({ ...fromStart, from: first.next, maxBytes: 4 });
    expect(second).toEqual({ records: ['a1', 'a2'], next: { segment: 2, record: 1 }, status: 'complete' });
    expect(await codeOf(b.readJournal({ ...fromStart, maxBytes: 0 }))).toBe('bad-name');
  });

  it('fichier dans le nuage, ligne incomplète, segment absent : cloud-pending, curseur sur place', async () => {
    folder.setAvailability(A, seg(E1, 2), 'cloud');
    expect(await b.readJournal(fromStart)).toEqual({ records: ['a0', 'a1'], next: { segment: 2, record: 0 }, status: 'cloud-pending' });
    const pending = (await b.scan({ keep: [] })).devices.find((d) => d.deviceId === A)?.pending;
    expect(pending).toEqual([{ file: seg(E1, 2), availability: 'cloud' }]);
    folder.setAvailability(A, seg(E1, 2), 'local');
    folder.setPartialTail(A, seg(E1, 1), true);
    expect(await b.readJournal(fromStart)).toEqual({ records: ['a0', 'a1'], next: { segment: 1, record: 2 }, status: 'cloud-pending' });
    folder.setPartialTail(A, seg(E1, 1), false);
    folder.removeFile(A, seg(E1, 2));
    expect((await b.readJournal({ ...fromStart, from: { segment: 1, record: 2 } })).status).toBe('cloud-pending');
  });

  it('corruption au milieu : truncated, rien au-delà', async () => {
    folder.corruptRecord(A, seg(E1, 1), 1);
    expect(await b.readJournal(fromStart)).toEqual({ records: ['a0'], next: { segment: 1, record: 1 }, status: 'truncated' });
  });

  it('autre époque que la tête : rien à lire, en attente ; paramètres invalides : bad-name', async () => {
    expect(await b.readJournal({ ...fromStart, epoch: E2 })).toEqual({ records: [], next: { segment: 0, record: 0 }, status: 'cloud-pending' });
    expect(await codeOf(b.readJournal({ ...fromStart, deviceId: 'pc' as DeviceId }))).toBe('bad-name');
    expect(await codeOf(b.readJournal({ ...fromStart, from: { segment: 0, record: 3 } }))).toBe('bad-name');
    expect(await b.readJournal({ ...fromStart, deviceId: C })).toEqual({ records: [], next: { segment: 0, record: 0 }, status: 'cloud-pending' });
  });

  it('segment trop grand : too-large avant lecture', async () => {
    folder.addBytes(A, seg(E1, 1), 8 * 1024 * 1024);
    expect(await codeOf(b.readJournal(fromStart))).toBe('too-large');
  });
});

describe('scan (sections 1.1, 1.4, 1.6, 3.4)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await publish(a);
  });

  it('appareil d’une autre clé : foreign pour lui seul ; lecture refusée (key-mismatch)', async () => {
    const c = await firstDevice(new MemorySyncFolder('c'), C);
    c.testing.setChooser(folder);
    await c.folder.choose();
    await publish(c, C);
    const scan = await a.scan({ keep: [] });
    expect(scan.devices.map((d) => [d.deviceId, d.stateStatus])).toEqual([
      [A, 'ok'],
      [C, 'foreign'],
    ]);
    expect(scan.devices[1]?.kid).toBe((await c.key.status()).kid);
    expect(await codeOf(a.readJournal({ deviceId: C, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('key-mismatch');
  });

  it('ancien state.ctx relivré : rollback, dernier état gardé ailleurs (anti-rejeu)', async () => {
    const b = await pairByQr(a, folder);
    const old = folder.takeState(A);
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(20), records: ['r1'] });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 1, record: 2, hlc: hlc(20) }) });
    expect((await b.scan({ keep: [] })).devices.find((d) => d.deviceId === A)?.state?.stateSeq).toBe(2);
    folder.putState(old);
    const replay = (await b.scan({ keep: [] })).devices.find((d) => d.deviceId === A);
    expect(replay?.stateStatus).toBe('rollback');
    expect(replay?.state).toBeNull();
    expect(await codeOf(b.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } }))).toBe('rollback');
  });

  it('state.ctx corrompu ou trop grand', async () => {
    folder.corruptRecord(A, 'state.ctx', 0);
    expect((await a.scan({ keep: [] })).devices[0]?.stateStatus).toBe('corrupt');
    const big = new MemorySyncFolder('big');
    const p = await firstDevice(big);
    await publish(p);
    big.addBytes(A, 'state.ctx', 400_000);
    expect((await p.scan({ keep: [] })).devices[0]?.stateStatus).toBe('too-large');
  });

  it('copies de conflit, temporaires et noms étrangers ignorés et comptés', async () => {
    folder.addStrayEntries(null, 2);
    folder.addStrayEntries(A, 3);
    folder.addDeviceFolder('pas-un-uuid');
    const scan = await a.scan({ keep: [] });
    expect(scan.ignored).toBe(6);
    expect(scan.devices).toHaveLength(1);
    expect(scan.incomplete).toBe(false);
  });

  it('plus de 10 000 entrées dans un dossier : scan incomplet', async () => {
    folder.addStrayEntries(A, 10_000);
    expect((await a.scan({ keep: [] })).incomplete).toBe(true);
  });

  it('plus de 16 dossiers d’appareils : son propre dossier gardé, surnombre écarté et signalé', async () => {
    for (let i = 0; i < 16; i += 1) folder.addDeviceFolder(`${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
    const scan = await a.scan({ keep: [] });
    expect(scan.tooManyDevices).toBe(true);
    expect(scan.devices).toHaveLength(16);
    expect(scan.devices.some((d) => d.deviceId === A)).toBe(true);
    expect(scan.ignored).toBe(1);
  });

  it('dossier de plus de 4 Gio : folder-too-large ; taille totale rendue', async () => {
    expect((await a.scan({ keep: [] })).totalBytes).toBeGreaterThan(0);
    folder.padFolder(FOLDER_STOP_BYTES);
    expect(await codeOf(a.scan({ keep: [] }))).toBe('folder-too-large');
  });

  it('state.ctx dans le nuage : cloud-pending et listé en attente', async () => {
    folder.setAvailability(A, 'state.ctx', 'cloud');
    const device = (await a.scan({ keep: [] })).devices[0];
    expect(device?.stateStatus).toBe('cloud-pending');
    expect(device?.pending).toEqual([{ file: 'state.ctx', availability: 'cloud' }]);
  });

  it('state.ctx avec une ligne incomplète : cloud-pending, pas corrupt', async () => {
    folder.setPartialTail(A, 'state.ctx', true);
    expect((await a.scan({ keep: [] })).devices[0]?.stateStatus).toBe('cloud-pending');
  });

  it('segment annoncé par la tête mais absent : listé en attente', async () => {
    await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: ['r1'] });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 2, record: 1, hlc: hlc(20) }) });
    folder.removeFile(A, seg(E1, 2));
    expect((await a.scan({ keep: [] })).devices[0]?.pending).toEqual([{ file: seg(E1, 2), availability: 'cloud' }]);
  });

  it('keep : les appareils connus ne sont jamais écartés par le plafond de 16 ; identifiant invalide : bad-name', async () => {
    const ids = Array.from({ length: 16 }, (_, i) => `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` as DeviceId);
    for (const id of ids) folder.addDeviceFolder(id);
    const capped = await a.scan({ keep: [] });
    expect(capped.devices).toHaveLength(16);
    const lost = ids.find((id) => !capped.devices.some((d) => d.deviceId === id));
    expect(lost).toBeDefined();
    const kept = await a.scan({ keep: lost ? [lost] : [] });
    expect(kept.devices.some((d) => d.deviceId === lost)).toBe(true);
    expect(kept.devices.some((d) => d.deviceId === A)).toBe(true);
    const all = await a.scan({ keep: ids });
    expect(all.devices).toHaveLength(17);
    expect(all.tooManyDevices).toBe(false);
    expect(await codeOf(a.scan({ keep: ['pc' as DeviceId] }))).toBe('bad-name');
    expect(await codeOf(a.scan({ keep: 'tous' } as unknown as { keep: DeviceId[] }))).toBe('bad-name');
  });

  it('changer de dossier oublie les états acceptés de l’ancien (anti-rejeu par dossier)', async () => {
    const seq1 = folder.takeState(A);
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 1, sv: 14, maxHlc: hlc(20), records: ['r1'] });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 1, record: 2, hlc: hlc(20) }) });
    expect((await a.scan({ keep: [] })).devices[0]?.state?.stateSeq).toBe(2);
    const other = new MemorySyncFolder('autre');
    other.putState(seq1);
    a.testing.setChooser(other);
    await a.folder.choose();
    const device = (await a.scan({ keep: [] })).devices[0];
    expect(device?.stateStatus).toBe('ok');
    expect(device?.state?.stateSeq).toBe(1);
  });

  it('sans clé : key-missing', async () => {
    const p = createMemorySyncPlatform({ folder, nowMs: clock });
    await p.folder.choose();
    expect(await codeOf(p.scan({ keep: [] }))).toBe('key-missing');
  });
});

describe('instantanés (section 5)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  async function* pages(...list: string[][]): AsyncIterable<readonly string[]> {
    for (const page of list) yield page;
  }
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(2), records: ['r0'] });
  });

  it('écrit par pages, visible seulement une fois annoncé par l’état', async () => {
    await a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(['s0', 's1'], ['s2']) });
    const read = { deviceId: A, epoch: E1, seq: 1, fromRecord: 0 };
    await a.writeState({ sv: 14, state: stateOf(A, E1, 1, { segment: 1, record: 1, hlc: hlc(2) }) });
    expect(await a.readSnapshot(read)).toEqual({ records: [], next: { segment: 1, record: 0 }, status: 'cloud-pending' });
    await a.writeState({ sv: 14, state: stateOf(A, E1, 2, { segment: 1, record: 1, hlc: hlc(2) }, { snapshot: { seq: 1, endHlc: hlc(2) } }) });
    expect(await a.readSnapshot(read)).toEqual({ records: ['s0', 's1', 's2'], next: { segment: 1, record: 3 }, status: 'complete' });
    expect(await a.readSnapshot({ ...read, fromRecord: 1, maxBytes: 2 })).toEqual({ records: ['s1'], next: { segment: 1, record: 2 }, status: 'more' });
    expect((await a.scan({ keep: [] })).devices[0]?.epochs[0]?.snapshots).toEqual([1]);
  });

  it('numéro jamais réutilisé ; enregistrement trop grand : rien n’est validé', async () => {
    await a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(['s0']) });
    expect(await codeOf(a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(['s0']) }))).toBe('segment-mismatch');
    expect(await codeOf(a.writeSnapshot({ epoch: E1, seq: 2, sv: 14, records: pages(['ok'], ['x'.repeat(MAX_RECORD_PLAINTEXT_BYTES + 1)]) }))).toBe('too-large');
    expect(folder.fileNames(A)).toEqual([seg(E1, 1), `${E1}/s-00000001.cts`]);
    expect(await codeOf(a.writeSnapshot({ epoch: E1, seq: 0, sv: 14, records: pages() }))).toBe('bad-name');
  });
});

describe('suppression de ses fichiers (sections 5.3 et 9)', () => {
  let folder: MemorySyncFolder;
  let a: MemorySyncPlatform;
  beforeEach(async () => {
    folder = new MemorySyncFolder();
    a = await firstDevice(folder);
    await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(2), records: ['r0'] });
    await a.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hlc(3), records: ['r1'] });
  });

  it('segment ancien supprimé, idempotent ; époque courante et segment de tête refusés', async () => {
    expect(await a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }])).toBe(1);
    expect(await a.deleteOwn([{ epoch: E1, kind: 'j', n: 1 }])).toBe(0);
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'epoch' }]))).toBe('current-epoch');
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'j', n: 2 }]))).toBe('current-epoch');
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'j' }]))).toBe('bad-name');
    expect(await codeOf(a.deleteOwn([{ epoch: E1, kind: 'epoch', n: 1 }]))).toBe('bad-name');
    expect(folder.fileNames(A)).toEqual([seg(E1, 2)]);
  });

  it('ancienne époque supprimée en entier après le passage à la suivante', async () => {
    await a.appendJournal({ epoch: E2, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(1), records: ['x'] });
    expect(await a.deleteOwn([{ epoch: E1, kind: 'epoch' }])).toBe(2);
    expect(folder.fileNames(A)).toEqual([seg(E2, 1)]);
  });
});

describe('marqueur de restauration (ADR 0010, règle 2)', () => {
  it('lu puis effacé', async () => {
    const p = createMemorySyncPlatform({ nowMs: clock });
    expect(await p.restoreMarker.get()).toBeNull();
    const marker: RestoreMarker = {
      backup: 'circletasks-2026-10-01.db',
      backupTakenAt: '2026-10-01T08:00:00.000Z' as IsoDateTime,
      restoredAt: '2026-10-05T08:00:00.000Z' as IsoDateTime,
      schemaVersion: 14,
    };
    p.testing.setRestoreMarker(marker);
    expect(await p.restoreMarker.get()).toEqual(marker);
    await p.restoreMarker.clear();
    expect(await p.restoreMarker.get()).toBeNull();
  });
});
