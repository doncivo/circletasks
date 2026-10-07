import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EpochId } from '../../../src/domain/sync/format';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { readResetStatus, storedDeviceStatuses } from '../../../src/sync';
import { META, readJson } from '../../../src/sync/meta';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-02, QA de fin d'ordre 4 : scénarios croisés sur les trous impossibles à combler (ADR 0011 §5.5) : relances répétées,
 * trois appareils (oubli, réinitialisation), retour après plus de 180 jours, valeurs locales illisibles sur plusieurs cycles.
 * Horloge simulée, aucun délai.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

function refuseNextAppend(d: SimDevice): void {
  const real = d.platform.appendJournal.bind(d.platform);
  let refused = false;
  d.platform.appendJournal = async (request) => {
    if (!refused) {
      refused = true;
      throw new SyncPlatformError('segment-full');
    }
    return real(request);
  };
}

const resumes = (d: SimDevice, from = 0): number => d.logger.entries.slice(from).filter((e) => e.event === 'resumed-from-snapshot').length;
const statusOf = (d: SimDevice, of: string): string | undefined => d.service.status().devices.find((x) => x.deviceId === of)?.status;
const rowOf = async (d: SimDevice, of: string): Promise<string | undefined> => (await d.data.repos.sync.getStates()).find((r) => r.deviceId === of)?.status;
const titlesOf = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
const epochOf = (d: SimDevice): EpochId => [...(d.folder.devices.get(d.id)?.epochs.keys() ?? [])].at(-1) as EpochId;
const dropFirstSegment = (a: SimDevice, b: SimDevice): void => propagate(a.folder, b.folder, a.id, { drop: [`${epochOf(a)}/j-00000001.ctj`] });

async function deviceA(): Promise<SimDevice> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  devices.push(a);
  await setupFirst(a);
  await a.cycle();
  return a;
}
async function joiner(a: SimDevice, id: string, name: string): Promise<SimDevice> {
  const d = await createSimDevice(id, { name, clock: a.clock });
  devices.push(d);
  await pair(a, d);
  return d;
}
/** A a écrit T0 (j-1) puis T1 (j-2) ; seul l'instantané d'ouverture existe ; j-1 absent chez les lecteurs (purgé). */
async function openingSnapshotGap(): Promise<SimDevice> {
  const a = await deviceA();
  await a.createTask('T0');
  await a.cycle();
  refuseNextAppend(a);
  await a.createTask('T1');
  await a.cycle();
  return a;
}

describe('relances répétées avec un trou mémorisé', () => {
  it('QA-1 relance à chaque cycle : une seule reprise, trou et date de début inchangés, A corrupt visible chaque fois', async () => {
    const a = await openingSnapshotGap();
    const b = await joiner(a, B_ID, 'B');
    dropFirstSegment(a, b);
    await b.cycle();
    const gap = await readJson<Record<string, { since: string }>>(b.data.repos, META.segmentGaps);
    expect(gap).toHaveProperty(a.id);
    const since = gap?.[a.id]?.since;
    for (let i = 0; i < 4; i += 1) {
      await b.restart();
      expect(storedDeviceStatuses(await b.data.repos.sync.getStates(), {}).find((d) => d.deviceId === a.id)?.status, `relance ${String(i)}`).toBe('corrupt');
      dropFirstSegment(a, b);
      b.clock.advance(60_000);
      await b.cycle();
      expect(statusOf(b, a.id), `cycle ${String(i)}`).toBe('corrupt');
      expect(b.service.status().devices.find((d) => d.deviceId === a.id)?.gapSince).toBe(since);
    }
    expect(resumes(b)).toBe(1);
    expect((await readJson<Record<string, { since: string }>>(b.data.repos, META.segmentGaps))?.[a.id]?.since).toBe(since);
  });
});

describe('trois appareils avec un trou', () => {
  it('QA-2 B oublie A (trou) : trou de A effacé, C reste lu et actif, aucun corrupt résiduel', async () => {
    const a = await openingSnapshotGap();
    const b = await joiner(a, B_ID, 'B');
    const c = await joiner(a, C_ID, 'C');
    dropFirstSegment(a, b);
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    await c.createTask('TC');
    await c.cycle();
    propagate(c.folder, b.folder, c.id);
    b.clock.advance(11 * 60_000);
    expect(await b.service.forgetDevice(a.id)).toEqual({ kind: 'done' });
    dropFirstSegment(a, b);
    propagate(c.folder, b.folder, c.id);
    await b.cycle();
    expect(await readJson(b.data.repos, META.segmentGaps)).toBeNull();
    expect(await rowOf(b, c.id)).toBe('active');
    expect(await titlesOf(b)).toContain('TC');
    expect(b.service.status().devices.find((d) => d.deviceId === a.id)?.gapSince).toBeUndefined();
  });

  it('QA-3 B réinitialise la synchro avec un trou sur A : refus « en retard » visible et gardé, trou intact ; A oublié : la réinitialisation aboutit, trou effacé', async () => {
    const a = await openingSnapshotGap();
    const b = await joiner(a, B_ID, 'B');
    dropFirstSegment(a, b);
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    expect(await b.service.resetSync()).toEqual({ kind: 'lagging', device: a.id });
    expect(await readResetStatus(b.data.repos, b.clock.nowMs())).not.toBeNull();
    expect(await readJson(b.data.repos, META.segmentGaps)).toHaveProperty(a.id);
    expect(statusOf(b, a.id)).toBe('corrupt');
    b.clock.advance(11 * 60_000);
    expect(await b.service.forgetDevice(a.id)).toEqual({ kind: 'done' });
    dropFirstSegment(a, b);
    await b.cycle();
    expect(await readJson(b.data.repos, META.segmentGaps)).toBeNull();
    expect((await b.service.resetSync()).kind).toBe('started');
    await b.cycle();
    expect(await readJson(b.data.repos, META.segmentGaps)).toBeNull();
  });
});

describe('retour après plus de 180 jours', () => {
  it('QA-4 B corrupt par un trou, A muet 200 jours : l’état reste visible, puis comblé par un instantané de A', async () => {
    const a = await openingSnapshotGap();
    const b = await joiner(a, B_ID, 'B');
    dropFirstSegment(a, b);
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    b.clock.advance(200 * DAY);
    for (let i = 0; i < 2; i += 1) {
      dropFirstSegment(a, b);
      await b.cycle();
      expect(statusOf(b, a.id), `cycle ${String(i)}`).toBeDefined();
      expect(await readJson(b.data.repos, META.segmentGaps)).not.toBeNull();
    }
    // Après 200 jours, l'instantané hebdomadaire de B lui-même est éligible nouveau : une reprise de plus est permise, jamais une par cycle.
    const settled = resumes(b);
    expect(settled).toBeLessThanOrEqual(2);
    for (let i = 0; i < 3; i += 1) {
      dropFirstSegment(a, b);
      b.clock.advance(60_000);
      await b.cycle();
    }
    expect(resumes(b)).toBe(settled);
    await a.cycle();
    dropFirstSegment(a, b);
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('active');
    expect(await titlesOf(b)).toEqual(['T0', 'T1']);
  });
});

describe('valeurs locales illisibles sur plusieurs cycles', () => {
  const gapEntry = { epoch: `e0001-${A_ID}`, segment: 0, author: null, seq: null, since: '2026-10-05T08:00:00.000Z' };
  const cases: Array<[string, string]> = [
    [META.segmentGaps, '[]'],
    [META.segmentGaps, JSON.stringify({ [A_ID]: { ...gapEntry, segment: -1 } })],
    [META.segmentGaps, JSON.stringify({ pas_un_id: gapEntry })],
    [META.resumeTried, JSON.stringify({ epoch: `e0001-${A_ID}`, author: A_ID, seq: null })],
    [META.resumeTried, '[]'],
    [META.ownStateHlcs, '{}'],
    [META.ownStateHlcs, '[[2,"x"]]'],
    [META.ownStateHlcs, '[[1]]'],
  ];
  it.each(cases)('QA-5 %s illisible (%s) : visible au premier cycle seulement, réécrit, journalisé sans contenu', async (key, raw) => {
    const a = await deviceA();
    await a.data.repos.sync.setMeta(key, raw);
    const before = a.logger.entries.length;
    expect((await a.cycle()).stateUnreadable).toBe(true);
    for (let i = 0; i < 3; i += 1) expect((await a.cycle()).stateUnreadable ?? false, `cycle ${String(i + 2)}`).toBe(false);
    const logged = a.logger.entries.slice(before).filter((e) => e.event === 'state-unreadable');
    expect(logged).toHaveLength(1);
    expect(logged[0]?.detail).toEqual({ where: `sync_meta.${key}` });
    expect(await a.data.repos.sync.getMeta(key)).not.toBe(raw);
  });

});
