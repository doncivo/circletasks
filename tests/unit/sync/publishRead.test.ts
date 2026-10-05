import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_APPEND_CALL_BYTES, MAX_RECORD_PLAINTEXT_BYTES, SYNC_FORMAT_MAJOR, encryptedLineBytes, utf8Bytes } from '../../../src/domain/sync/format';
import { parseJournalRecord } from '../../../src/domain/sync/parse';
import type { TaskId } from '../../../src/domain/types';
import { hydrate, propagate, segmentPath } from '../../sim/syncCloudSim';
import { SCHEMA_VERSION, createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/** Publication et lecture (ADR 0011, sections 1.2 à 1.4, 3.3, 10.2 ; Y-02 critères 5 et 6, Y-05 critères 1, 5, 6 et 7). */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

/** Enregistrements publiés par un appareil dans son époque courante, dans l'ordre des segments. */
function journalOf(device: SimDevice): { segment: string; texts: string[] }[] {
  return device.folder
    .fileNames(device.id)
    .filter((name) => /\/j-\d{8}\.ctj$/.test(name))
    .map((segment) => ({ segment, texts: device.folder.records(device.id, segment) }));
}

describe('publication (Y-02 critère 5)', () => {
  it('opérations par ligne et par horloge de champ, hlc strictement croissants d’un enregistrement à l’autre', async () => {
    const [a] = await twoDevices();
    const t = await a.createTask('Un');
    a.clock.advance(10);
    await a.updateTask(t.id, { note: 'note' });
    a.clock.advance(10);
    for (let i = 0; i < 5; i += 1) await a.createTask(`T${String(i)}`);
    await a.cycle();
    const records = journalOf(a).flatMap((s) => s.texts).map((text) => parseJournalRecord(text));
    expect(records.every((r) => r !== null)).toBe(true);
    let previousMax = '';
    for (const record of records) {
      const hlcs = record?.ops.flatMap((op) => [...op.f.values()].map((f) => f[1])) ?? [];
      expect(hlcs.slice().sort()).toEqual(hlcs.slice().sort());
      expect(hlcs.every((h) => h > previousMax)).toBe(true);
      previousMax = hlcs.reduce((m, h) => (h > m ? h : m), previousMax);
    }
    // Une ligne dont deux champs ont des hlc différents donne deux opérations.
    const opsOfT = records.flatMap((r) => r?.ops ?? []).filter((op) => op.id === t.id);
    expect(opsOfT).toHaveLength(2);
  });

  it('file volumineuse (5 000 opérations, note de 200 Kio) : enregistrements de 256 Kio au plus, appels de 1 Mio au plus, segment suivant sur segment-full', async () => {
    const [a, b] = await twoDevices();
    const appends: number[] = [];
    const real = a.platform.appendJournal.bind(a.platform);
    vi.spyOn(a.platform, 'appendJournal').mockImplementation(async (r) => {
      appends.push(r.records.reduce((sum, text) => sum + encryptedLineBytes(utf8Bytes(text), SYNC_FORMAT_MAJOR, r.sv), 0));
      return real(r);
    });
    const long = await a.createTask('Longue note', { note: 'x'.repeat(200 * 1024) });
    await a.data.transaction(async (repos) => {
      await repos.tasks.createMany(
        Array.from({ length: 5_000 }, (_, i) => ({ ...long, id: `${String(i).padStart(8, '0')}-1111-4111-8111-aaaaaaaaaaaa` as TaskId, title: `Tâche ${String(i)}`, note: '' })),
      );
    });
    await a.cycle();
    const texts = journalOf(a).flatMap((s) => s.texts);
    expect(texts.every((text) => utf8Bytes(text) <= MAX_RECORD_PLAINTEXT_BYTES)).toBe(true);
    expect(appends.every((bytes) => bytes <= MAX_APPEND_CALL_BYTES)).toBe(true);
    expect(journalOf(a).length).toBeGreaterThan(1);
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(long.id))?.note.length).toBe(200 * 1024);
    expect((await b.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task'))[0]?.n).toBe(5_001);
  }, 120_000);

  it('arrêt brutal entre l’écriture du segment et le retrait de la file : rien n’est republié en double, l’autre appareil n’en voit aucun effet', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Avant l’arrêt');
    const real = a.platform.appendJournal.bind(a.platform);
    let signalAppended: () => void = () => undefined;
    const appended = new Promise<void>((resolve) => (signalAppended = resolve));
    vi.spyOn(a.platform, 'appendJournal').mockImplementation(async (r) => {
      await real(r);
      signalAppended();
      // Le processus s'arrête ici : la promesse ne se termine jamais, la transaction de retrait n'a pas lieu.
      return new Promise<Awaited<ReturnType<typeof real>>>(() => undefined);
    });
    void a.service.syncNow('manual');
    await appended;
    vi.restoreAllMocks();
    expect(await a.data.repos.sync.outboxCount()).toBeGreaterThan(0);
    await a.restart();
    await a.cycle();
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
    expect(a.logger.entries.some((e) => e.event === 'publish-failed')).toBe(false);
    expect(a.logger.entries.find((e) => e.event === 'inflight-resolved')?.detail).toEqual({ appended: true });
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Avant l’arrêt');
    expect(await b.driver.select('SELECT * FROM conflict_log')).toEqual([]);
    const after = await a.createTask('Après la reprise');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(after.id))?.title).toBe('Après la reprise');
  });

  it('redémarrage : la file d’envoi survit et part au cycle suivant (Y-05 critère 1)', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Hors ligne');
    await a.restart();
    expect(await a.data.repos.sync.outboxCount()).toBe(1);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Hors ligne');
  });
});

describe('lecture (Y-02 critère 6, Y-05 critère 7)', () => {
  it('ligne incomplète : la lecture s’arrête avant, le curseur n’avance pas, « En attente d’iCloud » ; relue au cycle suivant', async () => {
    const [a, b] = await twoDevices();
    const t1 = await a.createTask('Un');
    await a.cycle();
    a.clock.advance(5);
    const t2 = await a.createTask('Deux');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID, { partialLastLine: true });
    const status = await b.cycle();
    expect(status.phase).toBe('waiting-icloud');
    expect((await b.task(t1.id))?.title).toBe('Un');
    expect(await b.task(t2.id)).toBeNull();
    propagate(a.folder, b.folder, A_ID);
    expect((await b.cycle()).phase).toBe('idle');
    expect((await b.task(t2.id))?.title).toBe('Deux');
  });

  it('fichier resté dans le nuage ou segment manquant sous la tête : en attente, jamais sauté', async () => {
    const [a, b] = await twoDevices();
    const t1 = await a.createTask('Un');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID, { placeholder: true });
    // `state.ctx` dans le nuage aussi : rien n'est lisible.
    expect((await b.cycle()).phase).toBe('waiting-icloud');
    hydrate(b.folder, A_ID);
    await b.cycle();
    expect((await b.task(t1.id))?.title).toBe('Un');
    // Segment annoncé par la tête mais pas encore arrivé.
    const epoch = a.folder.fileNames(A_ID).find((n) => n.includes('/j-'))?.split('/')[0] ?? '';
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(1);
      await a.createTask(`Lot ${String(i)}`);
    }
    vi.spyOn(a.platform, 'appendJournal');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID, { drop: [segmentPath(epoch, 1)] });
    expect((await b.cycle()).pendingFiles.length).toBeGreaterThan(0);
    expect((await b.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task'))[0]?.n).toBe(1);
  });

  it('corruption au milieu d’un segment : reprise depuis l’instantané le plus récent qui couvre au-delà', async () => {
    const [a, b] = await twoDevices();
    const t1 = await a.createTask('Un');
    await a.cycle();
    a.clock.advance(5);
    const t2 = await a.createTask('Deux');
    await a.cycle();
    // Instantané hebdomadaire de A, qui couvre les deux tâches.
    a.clock.advance(8 * 86_400_000);
    await a.cycle();
    propagate(a.folder, b.folder, A_ID);
    const segment = a.folder.fileNames(A_ID).find((n) => /\/j-00000001\.ctj$/.test(n)) ?? '';
    b.folder.corruptRecord(A_ID, segment, 0);
    await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'resumed-from-snapshot')).toBe(true);
    expect((await b.task(t1.id))?.title).toBe('Un');
    expect((await b.task(t2.id))?.title).toBe('Deux');
  });

  it('copie de conflit iCloud et ancien state.ctx relivré : ignorée ; rollback détecté, dernier état accepté gardé', async () => {
    const [a, b] = await twoDevices();
    const t1 = await a.createTask('Un');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID, { conflictCopy: true });
    await b.cycle();
    expect((await b.task(t1.id))?.title).toBe('Un');
    const old = b.folder.takeState(A_ID);
    a.clock.advance(5);
    await a.createTask('Deux');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID);
    await b.cycle();
    b.folder.putState(old);
    await b.restart();
    await b.cycle();
    const rows = await b.driver.select<{ status: string }>('SELECT status FROM sync_state WHERE device_id = ?', [A_ID]);
    expect(rows[0]?.status).toBe('rollback');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('appareil qui rejoint : la base de A arrive par l’instantané puis par les journaux (SCHEMA_VERSION publié)', async () => {
    const [a, b] = await twoDevices();
    expect(SCHEMA_VERSION).toBe(17);
    const t = await a.createTask('Pour B');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Pour B');
  });
});
