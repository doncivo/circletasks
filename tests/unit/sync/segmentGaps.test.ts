import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EpochId } from '../../../src/domain/sync/format';
import type { IsoDateTime } from '../../../src/domain/types';
import { syncBannerFor } from '../../../src/domain/syncBanners';
import { SyncPlatformError } from '../../../src/platform/sync/types';
import { storedDeviceStatuses } from '../../../src/sync';
import { META, readJson } from '../../../src/sync/meta';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-02, quatrième revue, point B (ADR 0011 §5.5, « Trou impossible à combler ») : un segment nécessaire tenu pour purgé que la
 * reprise ne comble pas fait passer l'appareil `corrupt` (visible, persistant), mémorisé dans `sync_meta.segmentGaps` ; aucune reprise
 * répétée avec le même instantané éligible ; effacé par un instantané éligible nouveau qui comble le trou. Horloge simulée, aucun délai.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Le prochain ajout de `d` est refusé une fois (`segment-full`) : le moteur ouvre le segment suivant. */
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

async function deviceB(a: SimDevice): Promise<SimDevice> {
  const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
  devices.push(b);
  await pair(a, b);
  return b;
}

/**
 * Curseur au début de l'époque : A a écrit T0 (j-1) puis T1 (j-2) ; seul l'instantané d'ouverture de A existe (sans entrée de son
 * auteur) ; j-1 n'est plus dans la liste chez B (purgé). B arrive : la reprise le laisse à {époque, 0, 0} sur A.
 */
async function openingSnapshotGap(): Promise<[SimDevice, SimDevice]> {
  const a = await deviceA();
  await a.createTask('T0');
  await a.cycle();
  refuseNextAppend(a);
  await a.createTask('T1');
  await a.cycle();
  const b = await deviceB(a);
  dropFirstSegment(a, b);
  return [a, b];
}

describe('trou impossible à combler, curseur au début de l’époque (ancien instantané sans entrée de l’auteur)', () => {
  it('sur 5 cycles : une seule reprise, puis A corrupt (bandeau d’appareil visible), trou mémorisé', async () => {
    const [a, b] = await openingSnapshotGap();
    for (let i = 0; i < 5; i += 1) {
      dropFirstSegment(a, b);
      b.clock.advance(60_000);
      await b.cycle();
      expect(statusOf(b, a.id), `cycle ${String(i)}`).toBe('corrupt');
    }
    expect(resumes(b)).toBe(1);
    const banners = syncBannerFor(b.service.status(), { join: null, devices: null, blocking: null, readFailed: false }, null);
    expect(banners.troubles.map((t) => t.code)).toContain('device-corrupt');
    expect(await readJson<Record<string, unknown>>(b.data.repos, 'segmentGaps')).toMatchObject({ [a.id]: { epoch: epochOf(a), segment: 0, author: a.id, seq: 1 } });
  });

  it('corrupt persiste à la relance (Réglages et Détails le lisent dans sync_state) et après un cycle', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    await b.restart();
    expect(storedDeviceStatuses(await b.data.repos.sync.getStates(), {}).find((d) => d.deviceId === a.id)?.status).toBe('corrupt');
    dropFirstSegment(a, b);
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    expect(resumes(b)).toBe(1);
  });

  it('tête de A qui bouge sans nouvel instantané : corrupt gardé, aucune reprise', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    const before = b.logger.entries.length;
    for (let i = 0; i < 3; i += 1) {
      await a.createTask(`A${String(i)}`);
      await a.cycle();
      dropFirstSegment(a, b);
      await b.cycle();
      expect(statusOf(b, a.id)).toBe('corrupt');
    }
    expect(resumes(b, before)).toBe(0);
  });

  it('nouvel instantané éligible de A : une reprise, lecture complète, trou effacé, A de nouveau actif', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    a.clock.advance(8 * DAY);
    await a.cycle();
    expect(a.logger.entries.some((e) => e.event === 'snapshot-written')).toBe(true);
    const before = b.logger.entries.length;
    dropFirstSegment(a, b);
    expect((await b.cycle()).phase).toBe('idle');
    expect(resumes(b, before)).toBe(1);
    expect(statusOf(b, a.id)).toBe('active');
    expect(await titlesOf(b)).toEqual(['T0', 'T1']);
    expect(await readJson<Record<string, unknown>>(b.data.repos, 'segmentGaps') ?? {}).not.toHaveProperty(a.id);
    dropFirstSegment(a, b);
    await b.cycle();
    expect(resumes(b, before)).toBe(1);
  });
});

describe('trou impossible à combler, segment k ≥ 1 tenu pour purgé après la reprise', () => {
  it('sur 5 cycles : une seule reprise, puis A corrupt ; nouvel instantané éligible : comblé', async () => {
    const a = await deviceA();
    await a.createTask('T0');
    await a.cycle();
    // B lit j-1 ; son état n'arrive jamais chez A (A ne le connaît pas : aucune preuve, règle des 30 jours).
    const b = await deviceB(a);
    propagate(a.folder, b.folder, a.id);
    await b.cycle();
    expect(await titlesOf(b)).toEqual(['T0']);
    // Instantané hebdomadaire de A, tête dans j-1 ; puis T1 dans j-2.
    a.clock.advance(8 * DAY);
    await a.cycle();
    refuseNextAppend(a);
    await a.createTask('T1');
    await a.cycle();
    dropFirstSegment(a, b);
    // 40 jours plus tard (A n'a pas tourné depuis) : j-1 tenu pour purgé, la reprise le laisse dans j-1.
    a.clock.advance(40 * DAY);
    const before = b.logger.entries.length;
    for (let i = 0; i < 5; i += 1) {
      b.clock.advance(60_000);
      await b.cycle();
      expect(statusOf(b, a.id), `cycle ${String(i)}`).toBe('corrupt');
    }
    expect(resumes(b, before)).toBe(1);
    expect(await readJson<Record<string, unknown>>(b.data.repos, 'segmentGaps')).toMatchObject({ [a.id]: { segment: 1, author: expect.any(String) as string } });
    // A tourne : nouvel instantané (tête dans j-2) ; B reprend une fois, lit tout, trou effacé.
    await a.cycle();
    dropFirstSegment(a, b);
    const later = b.logger.entries.length;
    expect((await b.cycle()).phase).toBe('idle');
    expect(resumes(b, later)).toBe(1);
    expect(statusOf(b, a.id)).toBe('active');
    expect(await titlesOf(b)).toEqual(['T0', 'T1']);
  });
});

describe('effacement du trou', () => {
  it('changement d’époque : trou effacé, A de nouveau actif, lecture complète', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    // A applique partout une restauration : il ouvre l'époque suivante (instantané de remplacement).
    a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
    await a.service.chooseRestoreOption('apply-everywhere');
    await a.cycle();
    propagate(a.folder, b.folder, a.id);
    await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'epoch-switched')).toBe(true);
    expect(await readJson(b.data.repos, META.segmentGaps)).toBeNull();
    expect(statusOf(b, a.id)).toBe('active');
    expect(await titlesOf(b)).toEqual(await titlesOf(a));
  });
});

describe('trous mémorisés illisibles', () => {
  it('sync_meta.segmentGaps corrompu : state-unreadable visible, journalisé, jamais lu comme « aucun trou »', async () => {
    const a = await deviceA();
    await a.data.repos.sync.setMeta(META.segmentGaps, JSON.stringify({ [B_ID]: { epoch: 'pas une époque', segment: 1, author: null, seq: null, since: '2026-10-05T08:00:00.000Z' } }));
    const status = await a.cycle();
    expect(status.stateUnreadable).toBe(true);
    expect(a.logger.entries.filter((e) => e.event === 'state-unreadable').map((e) => e.detail)).toContainEqual({ where: 'sync_meta.segmentGaps' });
  });
});
