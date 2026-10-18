// Y-TECH-03 (B13 de docs/audit-1.0.md), critères 2, 4 à 9 et 11 : `MemorySyncFolder` armé d'un plan de pannes, vu par `SyncPlatform`
// (mêmes traductions que store.rs). Horloge injectée, rangs d'appel et cycles comptés : aucune attente réelle.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeviceId, Hlc } from '../../domain/types';
import { epochId, type DeviceAck, type PublishedDeviceState } from '../../domain/sync/format';
import { createMemorySyncPlatform, MemorySyncFolder, MUTE_DEADLINE_TURNS, type MemorySyncPlatform } from './memory';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e' as DeviceId;
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as DeviceId;
const E1 = epochId(1, A);
const SEGMENT = `${E1}/j-00000001.ctj`;
const S1 = `${E1}/s-00000001.cts`;
const S2 = `${E1}/s-00000002.cts`;
const hlc = (ms: number): Hlc => `${String(ms).padStart(15, '0')}-0000-${A}` as Hlc;
const nowMs = (): number => 1_800_000_000_000;
const RECORDS = ['{"k":"ops","n":1}', '{"k":"ops","n":2}'];

function state(seq: number, snapshot: number, head = { segment: 1, record: 2, hlc: hlc(20) }): PublishedDeviceState {
  return {
    deviceId: A,
    platform: 'windows',
    appVersion: '0.1.1',
    sm: 1,
    sv: 14,
    epoch: E1,
    stateSeq: seq,
    head: { epoch: E1, ...head, stateSeq: seq },
    acks: new Map<DeviceId, DeviceAck>(),
    snapshot: { seq: snapshot, endHlc: hlc(30) },
    purgeHorizon: null,
    lastSyncHlc: hlc(40),
    forgotten: [],
    reset: null,
  };
}

const pages = (rows: readonly string[]): AsyncIterable<readonly string[]> =>
  (async function* () {
    yield rows;
  })();

/** A publie deux enregistrements, deux instantanés et son état ; B, associé par la clé de secours, lit le même dossier. */
async function twoDevices(): Promise<{ folder: MemorySyncFolder; a: MemorySyncPlatform; b: MemorySyncPlatform }> {
  const folder = new MemorySyncFolder();
  const a = createMemorySyncPlatform({ folder, nowMs });
  await a.folder.choose();
  await a.bindDevice(A);
  await a.key.create();
  await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 0, sv: 14, maxHlc: hlc(20), records: RECORDS });
  await a.writeSnapshot({ epoch: E1, seq: 1, sv: 14, records: pages(['{"k":"snap-rows"}', '{"k":"snap-end"}']) });
  await a.writeSnapshot({ epoch: E1, seq: 2, sv: 14, records: pages(['{"k":"snap-end"}']) });
  await a.writeState({ sv: 14, state: state(1, 2) });
  await a.key.openPairing('show');
  const { recoveryKey } = await a.key.pairingPayload();
  await a.key.closePairing();
  const b = createMemorySyncPlatform({ folder, nowMs });
  await b.folder.choose();
  await b.bindDevice(B);
  await b.key.openPairing('import');
  await b.key.import({ recoveryKey });
  await b.scan({ keep: [] });
  return { folder, a, b };
}

const journal = (b: MemorySyncPlatform) => b.readJournal({ deviceId: A, epoch: E1, from: { segment: 0, record: 0 } });
const listedOf = async (p: MemorySyncPlatform) => (await p.scan({ keep: [] })).devices.find((d) => d.deviceId === A);
const plan = (faults: readonly Record<string, unknown>[], options?: Record<string, unknown>): unknown => ({ name: 'essai', ...(options ? { options } : {}), faults });
const at = (file: string): string => `devices/${A}/${file}`;

/** Promesse observée sans attente : vrai dès qu'elle est réglée (aucun délai, seulement des tours de micro-tâches comptés). */
function watch<T>(promise: Promise<T>): { settled: () => boolean; result: Promise<T> } {
  let done = false;
  const result = promise.finally(() => {
    done = true;
  });
  return { settled: () => done, result };
}
const turns = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

describe('Y-TECH-03 : suppression en échec (critères 2 et 5)', () => {
  for (const code of ['io', 'cloud-pending'] as const) {
    it(`${code} : rejet avec le code, fichier toujours listé et lisible, seconde suppression réussie`, async () => {
      const { folder, a, b } = await twoDevices();
      folder.armFaults(plan([{ id: 'remove-s1', op: 'remove', file: at(S1), nth: 1, effect: 'error', code }]));
      await expect(a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).rejects.toMatchObject({ code });
      expect(folder.fileNames(A)).toContain(S1);
      expect((await listedOf(b))?.epochs.find((e) => e.epoch === E1)?.snapshots).toEqual([1, 2]);
      expect(folder.records(A, S1)).toEqual(['{"k":"snap-rows"}', '{"k":"snap-end"}']);
      expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(1);
      expect(folder.fileNames(A)).not.toContain(S1);
      expect(folder.faultLog()).toEqual([{ id: 'remove-s1', op: 'remove', path: at(S1), call: 1 }]);
    });
  }

  it('critère 2 : un autre fichier se supprime normalement ; seule la première suppression du fichier désigné échoue', async () => {
    const { folder, a } = await twoDevices();
    folder.armFaults(plan([{ id: 'remove-s1', op: 'remove', file: 'devices/*/e0001-*/s-00000001.cts', nth: 1, effect: 'error', code: 'io' }]));
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 2 }])).toBe(1);
    await expect(a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).rejects.toMatchObject({ code: 'io' });
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(1);
    expect(folder.fileNames(A)).toEqual([SEGMENT, 'state.ctx']);
  });

  it('suppression d’une époque : arrêt à la première suppression en échec, dossier gardé, reprise au rang suivant', async () => {
    const { folder, a } = await twoDevices();
    const other = epochId(2, A);
    // Seconde époque avec un instantané seul (fichier d'une époque non courante).
    folder.putLines(A, `${other}/s-00000001.cts`, ['{"k":"snap-end"}']);
    folder.armFaults(plan([{ id: 'remove-epoch-s1', op: 'remove', file: `devices/*/${other}/s-00000001.cts`, nth: 1, effect: 'error', code: 'io' }]));
    await expect(a.deleteOwn([{ epoch: other, kind: 'epoch' }])).rejects.toMatchObject({ code: 'io' });
    expect(folder.devices.get(A)?.epochs.has(other)).toBe(true);
    expect(await a.deleteOwn([{ epoch: other, kind: 'epoch' }])).toBe(1);
    expect(folder.devices.get(A)?.epochs.has(other)).toBe(false);
  });
});

describe('Y-TECH-03 : suppression acceptée mais non propagée (critère 6)', () => {
  it('N = 2 : disparaît du listage local, revient (même nom, même contenu) après exactement 2 cycles', async () => {
    const { folder, a, b } = await twoDevices();
    const before = folder.records(A, S1);
    folder.armFaults(plan([{ id: 'back', op: 'remove', file: at(S1), nth: 1, effect: 'accept-not-propagated', resurrectAfterCycles: 2 }]));
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(1);
    expect((await listedOf(b))?.epochs.find((e) => e.epoch === E1)?.snapshots).toEqual([2]);
    expect(folder.advanceCycle()).toBe(0);
    expect(folder.fileNames(A)).not.toContain(S1);
    expect(folder.advanceCycle()).toBe(1);
    expect((await listedOf(b))?.epochs.find((e) => e.epoch === E1)?.snapshots).toEqual([1, 2]);
    expect(folder.records(A, S1)).toEqual(before);
  });

  it('N = 0 : ne revient jamais (cas de référence, comportement d’avant la story)', async () => {
    const { folder, a } = await twoDevices();
    folder.armFaults(plan([{ id: 'gone', op: 'remove', file: at(S1), nth: 1, effect: 'accept-not-propagated', resurrectAfterCycles: 0 }]));
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(1);
    for (let i = 0; i < 5; i += 1) expect(folder.advanceCycle()).toBe(0);
    expect(folder.fileNames(A)).not.toContain(S1);
  });
});

describe('Y-TECH-03 : éviction après lecture et substitut (critère 7)', () => {
  it('segment lu puis évincé : listé dans le nuage, relu seulement après une hydratation', async () => {
    const { folder, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'evict', op: 'read', file: at(SEGMENT), nth: 1, effect: 'evict-after-read' }]));
    expect(await journal(b)).toMatchObject({ status: 'complete', records: RECORDS });
    expect(folder.availabilityOf(A, SEGMENT)).toBe('cloud');
    expect(folder.isPlaceholder(A, SEGMENT)).toBe(true);
    expect((await listedOf(b))?.pending).toEqual([{ file: SEGMENT, availability: 'cloud' }]);
    expect((await journal(b)).status).toBe('cloud-pending');
    b.testing.setHydrationDelay(1_000);
    await b.scan({ keep: [] });
    expect(await journal(b)).toMatchObject({ status: 'complete', records: RECORDS });
    expect(folder.availabilityOf(A, SEGMENT)).toBe('local');
    expect(folder.isPlaceholder(A, SEGMENT)).toBe(false);
  });

  it('substitut armé au listage : listé sous son vrai nom en nuage ; mode correct : supprimé avec le vrai nom', async () => {
    const { folder, a, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'placeholder', op: 'list', file: at(S1), nth: 1, effect: 'placeholder' }]));
    const listed = await listedOf(b);
    expect(listed?.epochs.find((e) => e.epoch === E1)?.snapshots).toEqual([1, 2]);
    expect(folder.isPlaceholder(A, S1)).toBe(true);
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(1);
    expect(folder.fileNames(A)).not.toContain(S1);
  });

  it('mode historique : remove du vrai nom laisse le substitut (rien supprimé, toujours listé)', async () => {
    const { folder, a, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'placeholder', op: 'list', file: at(S1), nth: 1, effect: 'placeholder' }], { removeLeavesPlaceholder: true }));
    await listedOf(b);
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(0);
    expect((await listedOf(b))?.epochs.find((e) => e.epoch === E1)?.snapshots).toEqual([1, 2]);
  });
});

describe('Y-TECH-03 : écrasé entre listage et lecture (critère 8)', () => {
  it('la lecture rend le contenu de l’autre appareil, le listage suivant montre sa nouvelle taille', async () => {
    const { folder, b } = await twoDevices();
    // Plus longs que le bourrage minimal d'une ligne chiffrée (environ 5,5 Kio) : la taille annoncée change.
    const other = [1, 2].map((n) => JSON.stringify({ k: 'ops', n, autre: 'appareil '.repeat(1_000) }));
    folder.armFaults(plan([{ id: 'overwrite', op: 'read', file: at(SEGMENT), nth: 1, effect: 'overwrite-before-read', content: other }]));
    const sizeBefore = folder.fileSize(A, SEGMENT);
    const totalBefore = (await b.scan({ keep: [] })).totalBytes;
    expect(await journal(b)).toMatchObject({ status: 'complete', records: other });
    expect(folder.fileSize(A, SEGMENT)).toBeGreaterThan(sizeBefore);
    expect((await b.scan({ keep: [] })).totalBytes - totalBefore).toBe(folder.fileSize(A, SEGMENT) - sizeBefore);
  });
});

describe('Y-TECH-03 : écriture refusée (critère 9)', () => {
  for (const code of ['io', 'cloud-pending'] as const) {
    it(`segment et état refusés (${code}) : rejet avec le code, aucun octet partiel visible`, async () => {
      const { folder, a } = await twoDevices();
      const records = folder.records(A, SEGMENT);
      const size = folder.fileSize(A, SEGMENT);
      const stateBefore = folder.takeState(A);
      folder.armFaults(plan([
        { id: 'append', op: 'write', file: at(SEGMENT), nth: 1, effect: 'error', code },
        { id: 'state', op: 'write', file: at('state.ctx'), nth: 1, effect: 'error', code },
      ]));
      await expect(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 2, sv: 14, maxHlc: hlc(50), records: ['{"k":"ops","n":3}'] })).rejects.toMatchObject({ code });
      expect(folder.records(A, SEGMENT)).toEqual(records);
      expect(folder.fileSize(A, SEGMENT)).toBe(size);
      await expect(a.writeState({ sv: 14, state: state(2, 2) })).rejects.toMatchObject({ code });
      expect(folder.takeState(A)).toEqual(stateBefore);
      // Rangs suivants : écritures normales, la tête n'a pas bougé.
      await a.appendJournal({ epoch: E1, segment: 1, expectRecords: 2, sv: 14, maxHlc: hlc(50), records: ['{"k":"ops","n":3}'] });
      await a.writeState({ sv: 14, state: state(2, 2, { segment: 1, record: 3, hlc: hlc(50) }) });
      expect(folder.records(A, SEGMENT)).toHaveLength(3);
    });
  }

  it('instantané refusé à l’écriture ou au renommage : aucun instantané visible', async () => {
    const { folder, a } = await twoDevices();
    folder.armFaults(plan([
      { id: 'tmp', op: 'write', file: `devices/*/${E1}/s-00000003.cts`, nth: 1, effect: 'error', code: 'io' },
      { id: 'commit', op: 'rename', file: `devices/*/${E1}/s-00000004.cts`, nth: 1, effect: 'error', code: 'cloud-pending' },
    ]));
    await expect(a.writeSnapshot({ epoch: E1, seq: 3, sv: 14, records: pages(['{"k":"snap-end"}']) })).rejects.toMatchObject({ code: 'io' });
    await expect(a.writeSnapshot({ epoch: E1, seq: 4, sv: 14, records: pages(['{"k":"snap-end"}']) })).rejects.toMatchObject({ code: 'cloud-pending' });
    expect(folder.fileNames(A)).toEqual([SEGMENT, S1, S2, 'state.ctx']);
  });

  it('partialLastLine explicite : lignes complètes écrites, dernière incomplète, appel en échec, own.json inchangé', async () => {
    const { folder, a, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'partial', op: 'write', file: at(SEGMENT), nth: 1, effect: 'error', code: 'io', partialLastLine: true }]));
    await expect(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 2, sv: 14, maxHlc: hlc(50), records: ['{"k":"ops","n":3}', '{"k":"ops","n":4}'] })).rejects.toMatchObject({ code: 'io' });
    expect(folder.records(A, SEGMENT)).toEqual([...RECORDS, '{"k":"ops","n":3}']);
    // Ligne incomplète au bout : le segment ne reçoit plus d'ajout (le moteur ouvre le suivant), la tête publiée se lit toujours.
    await expect(a.appendJournal({ epoch: E1, segment: 1, expectRecords: 3, sv: 14, maxHlc: hlc(60), records: ['{"k":"ops","n":5}'] })).rejects.toMatchObject({ code: 'segment-mismatch' });
    expect(await journal(b)).toMatchObject({ status: 'complete', records: RECORDS });
  });
});

describe('Y-TECH-03 : téléchargement en échec (critère 11)', () => {
  it('en attente avec le fichier toujours dans le nuage tant que l’entrée couvre le rang ; réussi au rang suivant', async () => {
    const { folder, b } = await twoDevices();
    folder.setAvailability(A, SEGMENT, 'cloud');
    b.testing.setHydrationDelay(1_000);
    folder.armFaults(plan([{ id: 'download', op: 'hydrate', file: at(SEGMENT), nth: 1, times: 2, effect: 'download-error' }]));
    expect((await journal(b)).status).toBe('cloud-pending');
    expect(folder.availabilityOf(A, SEGMENT)).toBe('cloud');
    expect((await journal(b)).status).toBe('cloud-pending');
    expect(folder.availabilityOf(A, SEGMENT)).toBe('cloud');
    expect(await journal(b)).toMatchObject({ status: 'complete', records: RECORDS });
    expect(folder.faultLog().map((f) => f.call)).toEqual([1, 2]);
  });

  it('lecture en échec io : readJournal rejeté io au rang 1, lu au rang 2 ; un état en io est illisible (corrupt), comme store.rs', async () => {
    const { folder, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'read-io', op: 'read', file: at(SEGMENT), nth: 1, effect: 'error', code: 'io' }]));
    await expect(journal(b)).rejects.toMatchObject({ code: 'io' });
    expect((await journal(b)).status).toBe('complete');
    folder.armFaults(plan([{ id: 'state-io', op: 'read', file: at('state.ctx'), nth: 1, times: 'all', effect: 'error', code: 'io' }]));
    expect((await listedOf(b))?.stateStatus).toBe('corrupt');
  });
});

describe('Y-TECH-03 : panne muette (scénario 5, mécanisme)', () => {
  it('scan sans réponse : promesse en suspens, aboutie par le test (rejeu), jamais par une attente', async () => {
    const { folder, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'mute', op: 'list', file: `devices/${A}/`, nth: 1, effect: 'mute' }]));
    const call = watch(b.scan({ keep: [] }));
    await turns(50);
    expect(call.settled()).toBe(false);
    expect(folder.mutedCalls()).toEqual([{ id: 'mute', call: 'scan' }]);
    expect(folder.releaseMuted('mute', 'complete')).toBe(true);
    expect((await call.result).devices.map((d) => d.deviceId)).toEqual([A]);
    expect(folder.mutedCalls()).toEqual([]);
  });

  it('lecture sans réponse rejetée par le test avec cloud-pending (réponse d’un transport borné)', async () => {
    const { folder, b } = await twoDevices();
    folder.armFaults(plan([{ id: 'mute-read', op: 'read', file: at(SEGMENT), nth: 1, effect: 'mute' }]));
    const call = watch(journal(b));
    await turns(50);
    expect(call.settled()).toBe(false);
    expect(folder.releaseMuted('mute-read', 'cloud-pending')).toBe(true);
    await expect(call.result).rejects.toMatchObject({ code: 'cloud-pending' });
    expect(folder.releaseMuted('mute-read', 'complete')).toBe(false);
  });
});

describe('Y-IOS-05 (B6) : échéance comptée du faux (critères 2 et 4)', () => {
  it('critère 4 : tout appel enveloppé encore en suspens à MUTE_DEADLINE_TURNS tours est rejeté cloud-pending, puis rien n’attend', async () => {
    const { folder, b } = await twoDevices();
    folder.armFaults(plan([
      { id: 'mute-read', op: 'read', file: at(SEGMENT), nth: 1, effect: 'mute' },
      { id: 'mute-snapshot', op: 'read', file: at(S2), nth: 1, effect: 'mute' },
      // Le listage d'époque (`listGate`) n'est traversé que par `scan` : troisième appel enveloppé.
      { id: 'mute-epoch', op: 'list', file: `${at(E1)}/`, nth: 1, effect: 'mute' },
    ]));
    // Un appel après l'autre (le faux n'attribue la panne muette qu'à l'appel en cours).
    const calls: [string, () => Promise<unknown>][] = [
      ['mute-read', () => journal(b)],
      ['mute-snapshot', () => b.readSnapshot({ deviceId: A, epoch: E1, seq: 2, fromRecord: 0, tail: true })],
      ['mute-epoch', () => b.scan({ keep: [] })],
    ];
    for (const [id, run] of calls) {
      const call = watch(run());
      const outcome = call.result.then(() => 'résolu', (error: unknown) => (error as { code?: string }).code);
      await turns(MUTE_DEADLINE_TURNS - 10);
      expect(call.settled(), id).toBe(false);
      expect(folder.mutedCalls().map((m) => m.id)).toEqual([id]);
      await turns(MUTE_DEADLINE_TURNS);
      expect(await outcome, id).toBe('cloud-pending');
      expect(folder.mutedCalls()).toEqual([]);
    }
    for (const id of ['mute-read', 'mute-snapshot', 'mute-epoch']) expect(folder.releaseMuted(id, 'complete'), id).toBe(false);
  });

  it('critère 2 : l’échéance est un compteur exporté (entier, 50 < n < 500), memory.ts n’ajoute ni minuterie ni horloge réelle', () => {
    expect(Number.isInteger(MUTE_DEADLINE_TURNS)).toBe(true);
    expect(MUTE_DEADLINE_TURNS).toBeGreaterThan(50);
    expect(MUTE_DEADLINE_TURNS).toBeLessThan(500);
    const source = readFileSync(new URL('./memory.ts', import.meta.url), 'utf8');
    // Présents avant la story (horloge par défaut du faux, ligne 961 ; date d'un échec d'import, ligne 2665) : comptes figés, rien d'ajouté.
    const baseline: Record<string, number> = { setTimeout: 0, setInterval: 0, 'Date.now': 1, 'performance.now': 0, 'new Date': 1 };
    for (const [token, count] of Object.entries(baseline)) expect(source.split(token).length - 1, token).toBe(count);
    const suspend = source.slice(source.indexOf('  suspend<T>('), source.indexOf('  mutedCalls(): '));
    expect(suspend).toContain('MUTE_DEADLINE_TURNS');
    for (const token of Object.keys(baseline)) expect(suspend.includes(token), token).toBe(false);
  });
});

describe('Y-TECH-03 : sans plan, comportement inchangé ; même plan, même résultat (critère 4)', () => {
  it('plan retiré : faux complaisant (suppression réussie, aucune panne au journal)', async () => {
    const { folder, a } = await twoDevices();
    folder.armFaults(plan([{ id: 'remove-s1', op: 'remove', file: at(S1), nth: 1, effect: 'error', code: 'io' }]));
    folder.disarmFaults();
    expect(await a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }])).toBe(1);
    expect(folder.faultLog()).toEqual([]);
  });

  it('deux exécutions du même plan et de la même suite d’appels : mêmes résultats, même journal des pannes', async () => {
    const run = async (): Promise<unknown> => {
      const { folder, a, b } = await twoDevices();
      folder.armFaults(plan([
        { id: 'read-io', op: 'read', file: at(SEGMENT), nth: 2, effect: 'error', code: 'io' },
        { id: 'remove-io', op: 'remove', file: 'devices/*/*/s-*.cts', nth: 1, effect: 'error', code: 'cloud-pending' },
        { id: 'evict', op: 'read', file: at(S2), nth: 1, effect: 'evict-after-read' },
      ]));
      const out: unknown[] = [];
      const settle = async (p: Promise<unknown>): Promise<void> => {
        out.push(await p.then((v) => ({ ok: v }), (e: unknown) => ({ error: (e as { code?: string }).code })));
      };
      await settle(journal(b));
      await settle(journal(b));
      await settle(b.readSnapshot({ deviceId: A, epoch: E1, seq: 2, fromRecord: 0, tail: true }));
      await settle(a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }]));
      await settle(a.deleteOwn([{ epoch: E1, kind: 's', n: 1 }]));
      await settle(listedOf(b).then((d) => ({ epochs: d?.epochs, pending: d?.pending, stateStatus: d?.stateStatus })));
      return { out, log: folder.faultLog(), names: folder.fileNames(A) };
    };
    expect(await run()).toEqual(await run());
  });
});
