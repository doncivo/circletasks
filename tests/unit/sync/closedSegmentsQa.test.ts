import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { epochId, type DeviceAck, type EpochId, type PublishedDeviceState } from '../../../src/domain/sync/format';
import { MAX_STATE_CLOSED_SEGMENTS } from '../../../src/domain/sync/limits';
import { parsePublishedStateText } from '../../../src/domain/sync/parse';
import type { DeviceId, Hlc } from '../../../src/domain/types';
import { createMemorySyncPlatform, MemorySyncFolder, type MemorySyncPlatform } from '../../../src/platform/sync/memory';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { propagate } from '../../sim/syncCloudSim';
import { armCrash } from '../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { B_ID as RB_ID, closeAll as closeRoom, publishedState, reassociate, setupRoom, settle as settleRoom, titles as roomTitles, type Room } from './reset/resetKit';

/**
 * Y-TECH-02 (QA), ADR 0011 §21 point 2 : `closed` des segments clos. iCloud qui livre dans le désordre à 2 et 3 appareils, troncature
 * pile sur une fin de ligne, lignes en trop, ligne incomplète, ancien état sans `closed`, 1 024 entrées, arrêt brutal entre l'ouverture
 * de k+1 et l'écriture de l'état, réinitialisation (changement d'époque). Horloge simulée, aucun délai réel, aucun retry.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let devices: SimDevice[] = [];
const room: Room = { devices: [] };
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  await closeRoom(room);
});

async function group(ids: readonly string[]): Promise<SimDevice[]> {
  const a = await createSimDevice(ids[0] as string, { name: 'A' });
  devices = [a];
  await setupFirst(a);
  await a.cycle();
  for (const id of ids.slice(1)) {
    const d = await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: a.clock });
    devices.push(d);
    await pair(a, d);
    await d.cycle();
  }
  for (let r = 0; r < 2; r += 1) {
    for (const d of devices) {
      syncFolders(devices);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
  syncFolders(devices);
  return devices;
}

/** Le prochain ajout de `a` est refusé une fois (`segment-full`) : le moteur ouvre le segment suivant. */
function refuseNextAppend(a: SimDevice): void {
  const real = a.platform.appendJournal.bind(a.platform);
  let refused = false;
  a.platform.appendJournal = async (request) => {
    if (!refused) {
      refused = true;
      throw new SyncPlatformError('segment-full');
    }
    return real(request);
  };
}

interface FileView {
  lines: { text: string; corrupt?: boolean }[];
  partialTail: boolean;
  availability: string;
}
const epochDirOf = (d: SimDevice, of: string) => {
  const [epoch, dir] = [...(d.folder.devices.get(of)?.epochs ?? new Map())].at(-1) as [EpochId, { segments: Map<number, FileView> }];
  return { epoch, dir };
};
const segmentOf = (d: SimDevice, of: string, n: number): FileView => epochDirOf(d, of).dir.segments.get(n) as FileView;
const titlesOf = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
const publishedClosed = (d: SimDevice, of: string): readonly { segment: number; records: number }[] | undefined => parsePublishedStateText(d.folder.devices.get(of)?.state?.lines[0]?.text ?? '')?.closed;

/** A écrit T1 (j-1, lu par les autres), T2 (j-1, pas encore livré), puis T3 dans j-2 (rotation). Renvoie j-1 tel que les autres le gardent (une ligne). */
async function writeThenRotate(a: SimDevice, others: readonly SimDevice[]): Promise<FileView> {
  await a.createTask('T1');
  await a.cycle();
  syncFolders(devices);
  for (const o of others) await o.cycle();
  const stale = structuredClone(segmentOf(others[0] as SimDevice, a.id, 1));
  a.clock.advance(1_000);
  await a.createTask('T2');
  await a.cycle();
  refuseNextAppend(a);
  a.clock.advance(1_000);
  await a.createTask('T3');
  await a.cycle();
  expect([...epochDirOf(a, a.id).dir.segments.keys()]).toEqual([1, 2]);
  expect(publishedClosed(a, a.id)).toEqual([{ segment: 1, records: 2 }]);
  return stale;
}

describe('désordre d’iCloud à trois appareils (§21 point 2)', () => {
  it('B : état et j-2 mais j-1 ancien ; C : tout. B attend sans rien sauter (cycles répétés), C lit tout ; puis B reçoit j-1 : bases identiques', async () => {
    const [a, b, c] = (await group([A_ID, B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    const stale = await writeThenRotate(a, [b, c]);
    propagate(a.folder, c.folder, a.id);
    propagate(a.folder, b.folder, a.id);
    epochDirOf(b, a.id).dir.segments.set(1, stale);
    for (let i = 0; i < 3; i += 1) {
      expect((await b.cycle()).phase, `cycle ${String(i)} de B`).toBe('waiting-icloud');
      expect(await titlesOf(b), 'B ne saute pas T2').toEqual(['T1']);
    }
    expect((await c.cycle()).phase).toBe('idle');
    expect(await titlesOf(c)).toEqual(['T1', 'T2', 'T3']);
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await titlesOf(b)).toEqual(['T1', 'T2', 'T3']);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(c)).toEqual(await taskSnapshot(a));
  });

  it('j-1 absent de la liste (état et j-2 seulement) : rien n’est sauté, lecture complète à l’arrivée du fichier, bases identiques', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    const { epoch } = epochDirOf(a, a.id);
    propagate(a.folder, b.folder, a.id, { drop: [`${epoch}/j-00000001.ctj`] });
    // Le fichier absent, jamais « sauté » : le numéro manquant n'est pas un trou.
    expect(epochDirOf(b, a.id).dir.segments.has(1)).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      await b.cycle();
      expect(await titlesOf(b), `cycle ${String(i)}`).toEqual(['T1']);
    }
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('j-1 absent de la liste alors que l’état annonce j-2 : « En attente d’iCloud » visible, pas de reprise depuis l’instantané à chaque cycle (exigence : aucun échec silencieux)', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    const { epoch } = epochDirOf(a, a.id);
    propagate(a.folder, b.folder, a.id, { drop: [`${epoch}/j-00000001.ctj`] });
    // Reprises comptées depuis ici (l'arrivée de B, dans `group`, en est une).
    const before = b.logger.entries.length;
    await b.cycle();
    const status = await b.cycle();
    expect(status.phase).toBe('waiting-icloud');
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'resumed-from-snapshot')).toHaveLength(0);
  });

  it('j-1 absent de la liste : aucune reprise depuis l’instantané sur 5 cycles, données figées, puis lecture complète à l’arrivée', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    const { epoch } = epochDirOf(a, a.id);
    propagate(a.folder, b.folder, a.id, { drop: [`${epoch}/j-00000001.ctj`] });
    const before = b.logger.entries.length;
    for (let i = 0; i < 5; i += 1) {
      expect((await b.cycle()).phase, `cycle ${String(i)}`).toBe('waiting-icloud');
      expect(await titlesOf(b)).toEqual(['T1']);
    }
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'resumed-from-snapshot')).toHaveLength(0);
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('j-1 resté dans le nuage (placeholder) : attente, jamais le segment suivant', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    propagate(a.folder, b.folder, a.id);
    segmentOf(b, a.id, 1).availability = 'cloud';
    expect((await b.cycle()).phase).toBe('waiting-icloud');
    expect(await titlesOf(b)).toEqual(['T1']);
    segmentOf(b, a.id, 1).availability = 'local';
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});

describe('segment tronqué, lignes en trop, ligne incomplète, ancien état', () => {
  it('tiers qui tronque j-1 pile sur une fin de ligne (une ligne de moins) : attente à chaque cycle, rien d’appliqué au-delà ; le vrai fichier répare', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    propagate(a.folder, b.folder, a.id);
    const file = segmentOf(b, a.id, 1);
    file.lines.splice(1);
    file.partialTail = false;
    for (let i = 0; i < 2; i += 1) {
      expect((await b.cycle()).phase).toBe('waiting-icloud');
      expect(await titlesOf(b)).toEqual(['T1']);
    }
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('j-1 vide chez le lecteur (tronqué à zéro ligne) : attente', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    propagate(a.folder, b.folder, a.id);
    segmentOf(b, a.id, 1).lines.splice(0);
    expect((await b.cycle()).phase).toBe('waiting-icloud');
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('lignes complètes en trop après le nombre annoncé de j-1 (copies et ligne indéchiffrable) : ignorées, bases identiques, pages exactes', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    propagate(a.folder, b.folder, a.id);
    const file = segmentOf(b, a.id, 1);
    const last = file.lines.at(-1) as { text: string };
    file.lines.push({ ...last }, { ...last }, { ...last, corrupt: true });
    const { epoch } = epochDirOf(b, a.id);
    const page = await b.platform.readJournal({ deviceId: a.id as DeviceId, epoch, from: { segment: 0, record: 0 } });
    expect(page.status).toBe('complete');
    expect(page.records).toHaveLength(3);
    expect(page.next).toEqual({ segment: 2, record: 1 });
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('ligne incomplète en fin de j-1 clos (nombre annoncé atteint) chez le lecteur : lu sans attente', async () => {
    const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
    await writeThenRotate(a, [b]);
    propagate(a.folder, b.folder, a.id);
    segmentOf(b, a.id, 1).partialTail = true;
    expect((await b.cycle()).phase).toBe('idle');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('ancien état sans `closed` (publié avant la story) : aucune clé publiée, lecture complète, bases identiques', async () => {
    const [a, b, c] = (await group([A_ID, B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await a.createTask('T1');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    await c.cycle();
    const real = a.platform.appendJournal.bind(a.platform);
    let refused = false;
    a.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        throw new SyncPlatformError('segment-full');
      }
      const head = await real(request);
      a.platform.testing.clearClosedSegments();
      return head;
    };
    a.clock.advance(1_000);
    await a.createTask('T2');
    await a.cycle();
    expect([...epochDirOf(a, a.id).dir.segments.keys()]).toEqual([1, 2]);
    expect(publishedClosed(a, a.id) ?? []).toEqual([]);
    expect(a.folder.devices.get(a.id)?.state?.lines[0]?.text).not.toContain('closed');
    syncFolders(devices);
    for (const d of [b, c]) {
      expect((await d.cycle()).phase, d.name).toBe('idle');
      expect(await taskSnapshot(d), d.name).toEqual(await taskSnapshot(a));
    }
  });
});

describe('plafond de 1 024 entrées (memory.ts)', () => {
  const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
  const E1 = epochId(1, A);
  const hlc = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;
  const head = (segment: number, record: number): DeviceAck => ({ epoch: E1, segment, record, hlc: hlc(10 * segment), stateSeq: 1 });
  const stateAt = (segment: number): PublishedDeviceState => ({
    deviceId: A,
    platform: 'windows',
    appVersion: '0.1.1',
    sm: 1,
    sv: 14,
    epoch: E1,
    stateSeq: 1,
    head: head(segment, 1),
    acks: new Map<DeviceId, DeviceAck>(),
    snapshot: null,
    purgeHorizon: null,
    lastSyncHlc: hlc(1_000_000),
    forgotten: [],
    reset: null,
  });

  async function written(count: number): Promise<{ folder: MemorySyncFolder; p: MemorySyncPlatform }> {
    const folder = new MemorySyncFolder();
    const p = createMemorySyncPlatform({ folder, nowMs: () => 1_800_000_000_000 });
    await p.folder.choose();
    await p.bindDevice(A);
    await p.key.create();
    for (let n = 1; n <= count; n += 1) await p.appendJournal({ epoch: E1, segment: n, expectRecords: 0, sv: 14, maxHlc: hlc(10 * n), records: [`{"s":${String(n)}}`] });
    await p.writeState({ sv: 14, state: stateAt(count) });
    return { folder, p };
  }

  it('1 030 segments : 1 024 entrées publiées (les plus récentes), lecture complète depuis le début, troncature dans la fenêtre détectée', async () => {
    const { folder, p } = await written(MAX_STATE_CLOSED_SEGMENTS + 6);
    const closed = parsePublishedStateText(folder.devices.get(A)?.state?.lines[0]?.text ?? '')?.closed ?? [];
    expect(closed).toHaveLength(MAX_STATE_CLOSED_SEGMENTS);
    expect(closed[0]).toEqual({ segment: 6, records: 1 });
    expect(closed.at(-1)).toEqual({ segment: MAX_STATE_CLOSED_SEGMENTS + 5, records: 1 });
    const all = await p.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } });
    expect([all.status, all.records.length, all.next]).toEqual(['complete', MAX_STATE_CLOSED_SEGMENTS + 6, { segment: MAX_STATE_CLOSED_SEGMENTS + 6, record: 1 }]);
    // Segment 500 (dans la fenêtre) tronqué à zéro ligne : attente à ce segment.
    (folder.devices.get(A)?.epochs.get(E1)?.segments.get(500) as unknown as FileView).lines.splice(0);
    const cut = await p.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } });
    expect([cut.status, cut.records.length, cut.next]).toEqual(['cloud-pending', 499, { segment: 500, record: 0 }]);
  });
});

async function scenario(): Promise<{ a: SimDevice; b: SimDevice }> {
  const [a, b] = (await group([A_ID, B_ID])) as [SimDevice, SimDevice];
  await a.createTask('T1');
  await a.cycle();
  syncFolders(devices);
  await b.cycle();
  a.clock.advance(1_000);
  await a.createTask('T2');
  await a.cycle();
  syncFolders(devices);
  await b.cycle();
  refuseNextAppend(a);
  a.clock.advance(1_000);
  await a.createTask('T3');
  return { a, b };
}

async function writesOfCycle(): Promise<number> {
  const { a } = await scenario();
  const probe = armCrash(a, null);
  await a.cycle();
  const writes = probe.writes;
  probe.disarm();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  return writes;
}
const writes = await writesOfCycle();


describe('arrêt brutal entre l’ouverture de k+1 et l’écriture de l’état', () => {
  it('le cycle de rotation compte des écritures', () => {
    expect(writes).toBeGreaterThan(2);
  });

  it.each(Array.from({ length: writes }, (_, i) => i + 1))('arrêt avant l’écriture %i : redémarrage, `closed` exact publié, B converge sans trou, aucune attente sans fin', async (n) => {
    const { a, b } = await scenario();
    const probe = armCrash(a, n);
    await a.cycle();
    expect(probe.crashed).toBe(true);
    probe.disarm();
    // iCloud livre ce qu'il y a (état éventuellement ancien, j-2 éventuellement déjà là) ; B lit ce qui est lisible sans rien sauter.
    syncFolders(devices);
    const early = await b.cycle();
    expect(['idle', 'waiting-icloud']).toContain(early.phase);
    await a.restart();
    for (let round = 0; round < 3; round += 1) {
      for (const d of [a, b]) {
        expect((await d.cycle()).phase, `${d.name} tour ${String(round)}`).toBe('idle');
        syncFolders(devices);
      }
    }
    expect(await titlesOf(b)).toEqual(['T1', 'T2', 'T3']);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    const closed = publishedClosed(a, a.id) ?? [];
    expect(closed.every((c) => c.records === (segmentOf(a, a.id, c.segment).lines.length))).toBe(true);
    const keys = [...epochDirOf(a, a.id).dir.segments.keys()];
    if (keys.length > 1) expect(closed).toEqual([{ segment: 1, records: segmentOf(a, a.id, 1).lines.length }]);
    expect(a.service.status().stateUnreadable ?? false).toBe(false);
  });
});

describe('réinitialisation (Y-11) et changement d’époque : `closed` limité à l’époque courante', () => {
  const closedOf = (text: string | undefined): unknown => (JSON.parse(text ?? '{}') as { closed?: unknown }).closed;

  it('l’état de la nouvelle époque ne porte aucun `closed` de l’ancienne ; la rotation suivante liste seulement ses segments ; B se réassocie et lit tout', async () => {
    const [a, b] = (await setupRoom(room, [RB_ID])) as [SimDevice, SimDevice];
    const real = a.platform.appendJournal.bind(a.platform);
    let refuse = 0;
    a.platform.appendJournal = async (request) => {
      if (refuse > 0) {
        refuse -= 1;
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
    await a.createTask('E1-a');
    await a.cycle();
    refuse = 1;
    a.clock.advance(1_000);
    await a.createTask('E1-b');
    await a.cycle();
    const oldState = a.folder.devices.get(a.id)?.state?.lines[0]?.text;
    expect(closedOf(oldState)).toEqual([{ segment: 1, records: expect.any(Number) }]);
    await settleRoom(room.devices, 2);

    expect((await a.service.resetSync()).kind).toBe('started');
    const next = publishedState(a, a.id, 'next');
    expect(next?.epoch).toMatch(/^e0002-/);
    expect(closedOf(a.folder.devices.get(a.id)?.nextState?.lines[0]?.text)).toBeUndefined();
    // L'ancien état (époque 1) garde ses entrées ; elles ne passent pas dans l'époque 2.
    expect(closedOf(a.folder.devices.get(a.id)?.state?.lines[0]?.text)).toEqual(closedOf(oldState));

    syncFolders([a, b]);
    expect((await b.cycle()).phase).toBe('reset-required');
    await reassociate(a, b, [a, b]);
    await b.cycle();
    await settleRoom([a, b], 3);
    expect((await a.platform.key.status()).nextKid ?? null).toBeNull();
    // Époque 2 : rotation à son tour ; l'entrée porte le segment 1 de l'époque 2, jamais celui de l'époque 1.
    await a.createTask('E2-a');
    await a.cycle();
    refuse = 1;
    a.clock.advance(1_000);
    await a.createTask('E2-b');
    await a.cycle();
    const text = a.folder.devices.get(a.id)?.state?.lines[0]?.text;
    const parsed = parsePublishedStateText(text ?? '') as PublishedDeviceState;
    expect(parsed.epoch).toMatch(/^e0002-/);
    for (const c of parsed.closed ?? []) expect(c.segment).toBeLessThan(parsed.head.segment);
    await settleRoom([a, b], 3);
    expect(await roomTitles(b)).toEqual(await roomTitles(a));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(await roomTitles(a)).toEqual(['E1-a', 'E1-b', 'E2-a', 'E2-b']);
  });

  it('memory.ts : `closed` fourni pour une autre époque que celle d’own.json est refusé (state-mismatch), l’époque suivante repart vide', async () => {
    const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
    const E1 = epochId(1, A);
    const E2 = epochId(2, A);
    const folder = new MemorySyncFolder();
    const p = createMemorySyncPlatform({ folder, nowMs: () => 1_800_000_000_000 });
    await p.folder.choose();
    await p.bindDevice(A);
    await p.key.create();
    const hl = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;
    await p.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hl(10), records: ['{"a":1}'] });
    await p.appendJournal({ epoch: E1, segment: 2, expectRecords: 0, sv: 14, maxHlc: hl(20), records: ['{"a":2}'] });
    const base = (epoch: EpochId, seq: number, seg: number, rec: number, closed?: { segment: number; records: number }[]): PublishedDeviceState => ({
      deviceId: A,
      platform: 'windows',
      appVersion: '0.1.1',
      sm: 1,
      sv: 14,
      epoch,
      stateSeq: seq,
      head: { epoch, segment: seg, record: rec, hlc: seg === 0 ? null : hl(20), stateSeq: seq } as DeviceAck,
      acks: new Map<DeviceId, DeviceAck>(),
      snapshot: null,
      purgeHorizon: null,
      lastSyncHlc: hl(1_000_000),
      forgotten: [],
      reset: null,
      ...(closed ? { closed } : {}),
    });
    await p.writeState({ sv: 14, state: base(E1, 1, 2, 1) });
    const code = await p.writeState({ sv: 14, state: base(E2, 2, 0, 0, [{ segment: 1, records: 1 }]) }).then(
      () => 'ok',
      (e: unknown) => (e instanceof SyncPlatformError ? e.code : 'autre'),
    );
    expect(code).toBe('state-mismatch');
    await p.writeState({ sv: 14, state: base(E2, 3, 0, 0) });
    expect(JSON.parse(folder.devices.get(A)?.state?.lines[0]?.text ?? '{}')).not.toHaveProperty('closed');
  });
});
