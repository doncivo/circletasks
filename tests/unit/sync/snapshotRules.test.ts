import { afterEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_CHUNK_PLAINTEXT_BYTES, utf8Bytes } from '../../../src/domain/sync/format';
import { parseSnapshotRecord } from '../../../src/domain/sync/parse';
import type { LocalDate, SpaceId, TaskId } from '../../../src/domain/types';
import { createSimDevice, pair, PRO, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';
import { propagate } from '../../sim/syncCloudSim';

/**
 * Instantané, purge de ses segments, écriture interrompue (ADR 0011, sections 5.1 à 5.3 ; Y-02 critères 11 et 12). Les durées sont
 * celles de l'horloge injectée (aucun délai réel).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
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

async function settle(list: readonly SimDevice[] = devices): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    for (const d of list) await d.cycle();
    syncFolders(list);
  }
}

const snapshotsOf = (d: SimDevice): string[] => d.folder.fileNames(d.id).filter((n) => /\/s-\d{8}\./.test(n));
const segmentsOf = (d: SimDevice): string[] => d.folder.fileNames(d.id).filter((n) => /\/j-\d{8}\./.test(n));

describe('écriture de l’instantané : conditions (Y-02 critère 11)', () => {
  it('pas avant 7 jours ; au bout de 7 jours, un seul appareil l’écrit (l’autre voit celui de l’autre)', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('Base');
    await settle();
    expect(snapshotsOf(a)).toHaveLength(1);
    a.clock.advance(7 * DAY - 60_000);
    await settle();
    expect(snapshotsOf(a), 'moins de 7 jours : aucun nouvel instantané').toHaveLength(1);
    expect(snapshotsOf(b)).toHaveLength(0);
    a.clock.advance(120_000);
    await a.cycle();
    expect(snapshotsOf(a), 'plus de 7 jours : un instantané').toHaveLength(2);
    syncFolders(devices);
    await b.cycle();
    expect(snapshotsOf(b), 'l’autre appareil n’en écrit pas de plus').toHaveLength(0);
  });

  it('un appareil dont un fichier n’est pas encore arrivé (nuage) : tous les actifs n’ont pas été lus, aucun instantané ; il est écrit dès que tout est lu', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('Base');
    await settle();
    await b.createTask('De B, publiée');
    await b.cycle();
    a.clock.advance(8 * DAY);
    // Le segment de B n'est pas encore arrivé chez A : la tête annoncée n'est pas atteinte.
    propagate(b.folder, a.folder, B_ID, { drop: segmentsOf(b) });
    propagate(a.folder, b.folder, A_ID);
    const before = snapshotsOf(a).length;
    const status = await a.cycle();
    expect(status.phase).toBe('waiting-icloud');
    expect(snapshotsOf(a), 'rien n’est lu en entier : pas d’instantané').toHaveLength(before);
    syncFolders(devices);
    await a.cycle();
    expect(snapshotsOf(a)).toHaveLength(before + 1);
  });

  it('2 instantanés gardés par appareil et par époque : le troisième efface le premier', async () => {
    const [a] = await twoDevices();
    await a.createTask('Base');
    await settle();
    for (let week = 0; week < 3; week += 1) {
      a.clock.advance(8 * DAY);
      await settle();
    }
    const kept = snapshotsOf(a);
    expect(kept).toHaveLength(2);
    expect(kept.map((n) => Number(/s-(\d{8})/.exec(n)?.[1]))).toEqual([3, 4]);
  });

  it('enregistrements de 64 Kio au plus, snap-end en dernier avec le décompte et les couvertures de chaque appareil', async () => {
    const [a] = await twoDevices();
    await a.data.transaction(async (repos) => {
      await repos.tasks.createMany(
        Array.from({ length: 150 }, (_, i) => ({
          id: `${String(i + 1).padStart(8, '0')}-2222-4222-8222-aaaaaaaaaaaa` as TaskId,
          spaceId: PRO as SpaceId,
          projectId: null,
          title: `Tâche ${String(i)}`,
          note: 'n'.repeat(1_024),
          date: '2026-10-05' as LocalDate,
          time: null,
          status: 'todo' as const,
          doneAt: null,
          sortOrder: i,
          carriedOver: false,
          recurrenceId: null,
          seriesIndex: null,
          seriesTemplate: null,
          goalId: null,
          icon: null,
          someday: false,
          source: 'local' as const,
          externalId: null,
          appleListId: null,
          appleRecurring: false,
          externalEventId: null,
        })),
      );
    });
    await settle();
    a.clock.advance(8 * DAY);
    await settle();
    const latest = snapshotsOf(a).at(-1) as string;
    const texts = a.folder.records(A_ID, latest);
    const parsed = texts.map((text) => parseSnapshotRecord(text));
    expect(parsed.every((r) => r !== null)).toBe(true);
    const rows = parsed.filter((r) => r?.k === 'snap-rows');
    expect(rows.length, 'plusieurs enregistrements de lignes').toBeGreaterThan(1);
    for (const text of texts) expect(utf8Bytes(text)).toBeLessThanOrEqual(SNAPSHOT_CHUNK_PLAINTEXT_BYTES + 4_096);
    for (const r of rows) expect(utf8Bytes(JSON.stringify(r))).toBeLessThanOrEqual(SNAPSHOT_CHUNK_PLAINTEXT_BYTES + 4_096);
    const end = parsed.at(-1);
    expect(end?.k).toBe('snap-end');
    if (end?.k === 'snap-end') {
      expect(end.count).toBe(texts.length - 1);
      expect([...end.covers.keys()].sort()).toEqual([A_ID, B_ID]);
    }
    expect(parsed.slice(0, -1).some((r) => r?.k === 'snap-end')).toBe(false);
  });
});

describe('instantané interrompu ou incomplet (Y-02 critère 11)', () => {
  it('arrêt après la première page : aucun fichier visible, l’état ne l’annonce pas, le cycle suivant l’écrit en entier', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(8 * DAY);
    const before = snapshotsOf(a);
    const real = a.platform.writeSnapshot.bind(a.platform);
    a.platform.writeSnapshot = async (request) => {
      const records = {
        async *[Symbol.asyncIterator]() {
          for await (const page of request.records) {
            yield page;
            throw new Error('arrêt simulé');
          }
        },
      };
      return real({ ...request, records });
    };
    const status = await a.cycle();
    expect(status.phase).toBe('error');
    expect(snapshotsOf(a), 'le .tmp abandonné n’est jamais visible').toEqual(before);
    a.platform.writeSnapshot = real;
    await a.restart();
    syncFolders(devices);
    expect((await b.cycle()).phase).toBe('idle');
    expect((await a.cycle()).phase).toBe('idle');
    expect(snapshotsOf(a)).toHaveLength(before.length + 1);
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Base');
  });

  it('un instantané sans snap-end est ignoré : rien n’en est appliqué à moitié, le nouvel appareil lit les journaux', async () => {
    const [a] = await twoDevices();
    const t = await a.createTask('Base');
    await settle();
    a.clock.advance(8 * DAY);
    await settle();
    const latest = snapshotsOf(a).at(-1) as string;
    const [epoch, name] = latest.split('/') as [string, string];
    const file = a.folder.devices.get(A_ID)?.epochs.get(epoch as never)?.snapshots.get(Number(/s-(\d{8})/.exec(name)?.[1]));
    expect(file?.lines.length).toBeGreaterThan(1);
    file?.lines.pop();
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: a.clock });
    devices.push(c);
    propagate(a.folder, c.folder, A_ID);
    await pair(a, c);
    expect((await c.cycle()).phase).toBe('idle');
    expect(c.logger.entries.some((e) => e.event === 'resumed-from-snapshot')).toBe(false);
    expect(c.logger.entries.some((e) => e.event === 'resume-unavailable')).toBe(true);
    // Les journaux de A (segments gardés) donnent les mêmes données.
    expect((await c.task(t.id))?.title).toBe('Base');
    expect(await taskSnapshot(c)).toEqual(await taskSnapshot(a));
  });

  it('deux appareils qui écrivent un instantané en même temps : sans danger, un nouvel appareil converge depuis l’un ou l’autre', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('De A');
    await b.createTask('De B');
    await settle();
    a.clock.advance(8 * DAY);
    // Chacun écrit le sien avant de voir celui de l’autre (aucune recopie entre les deux cycles).
    await a.cycle();
    await b.cycle();
    expect(snapshotsOf(a)).toHaveLength(2);
    expect(snapshotsOf(b)).toHaveLength(1);
    syncFolders(devices);
    await settle();
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: a.clock });
    devices.push(c);
    syncFolders(devices);
    await pair(a, c);
    syncFolders(devices);
    await settle(devices);
    expect(await taskSnapshot(c)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    expect(c.logger.entries.some((e) => e.event === 'resumed-from-snapshot')).toBe(true);
  });
});

describe('purge de ses propres segments (Y-02 critère 11, section 5.3)', () => {
  it('couvert par un instantané, accusé par tous et vieux de 30 jours : supprimé ; avant, jamais ; la tête reste ; un nouvel appareil converge', async () => {
    const [a, b] = await twoDevices();
    const first = await a.createTask('Dans le premier segment');
    await a.cycle();
    // Le segment 1 est « plein » : la publication suivante ouvre le segment 2.
    const real = a.platform.appendJournal.bind(a.platform);
    let refused = false;
    a.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        const { SyncPlatformError } = await import('../../../src/platform/sync/types');
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
    a.clock.advance(1_000);
    const second = await a.createTask('Dans le second segment');
    await a.cycle();
    a.platform.appendJournal = real;
    expect(segmentsOf(a)).toHaveLength(2);
    await settle();
    // Instantané qui couvre le segment 2 (tous les actifs ont lu), mais 8 jours seulement : le segment 1 reste.
    a.clock.advance(8 * DAY);
    await settle();
    expect(segmentsOf(a), 'moins de 30 jours après son dernier enregistrement : gardé').toHaveLength(2);
    a.clock.advance(31 * DAY);
    await settle();
    const left = segmentsOf(a);
    expect(left, 'segment 1 supprimé, la tête gardée').toHaveLength(1);
    expect(left[0]).toMatch(/j-00000002\./);
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: a.clock });
    devices.push(c);
    syncFolders(devices);
    await pair(a, c);
    syncFolders(devices);
    await settle(devices);
    for (const d of devices) {
      expect((await d.task(first.id))?.title, d.name).toBe('Dans le premier segment');
      expect((await d.task(second.id))?.title, d.name).toBe('Dans le second segment');
    }
    expect(await taskSnapshot(c)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('un appareil actif qui n’a pas accusé le segment le retient, même après 30 jours et un instantané', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('Un');
    await a.cycle();
    const real = a.platform.appendJournal.bind(a.platform);
    let refused = false;
    a.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        const { SyncPlatformError } = await import('../../../src/platform/sync/types');
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
    a.clock.advance(1_000);
    await a.createTask('Deux');
    await a.cycle();
    a.platform.appendJournal = real;
    expect(segmentsOf(a)).toHaveLength(2);
    // B reste en ligne (cycles) mais ne reçoit plus rien de A : il n'accuse pas le segment 1.
    for (let week = 0; week < 6; week += 1) {
      a.clock.advance(8 * DAY);
      await a.cycle();
      await b.cycle();
      propagate(b.folder, a.folder, B_ID);
    }
    expect(segmentsOf(a), 'B n’a rien accusé : rien n’est supprimé').toHaveLength(2);
  });
});
