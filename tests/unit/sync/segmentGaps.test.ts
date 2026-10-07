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

describe('cinquième revue, point 2 : valeurs locales du trou illisibles', () => {
  it('sync_meta.segmentGaps corrompu : state-unreadable au premier cycle (journalisé), lu comme aucun trou, réécrit, lignes corrupt remises à active ; second cycle propre', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    await b.data.repos.sync.setMeta(META.segmentGaps, JSON.stringify({ [A_ID]: { epoch: 'pas une époque', segment: 1, author: null, seq: null, since: '2026-10-05T08:00:00.000Z' } }));
    const before = b.logger.entries.length;
    dropFirstSegment(a, b);
    const first = await b.cycle();
    expect(first.stateUnreadable).toBe(true);
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'state-unreadable').map((e) => e.detail)).toContainEqual({ where: 'sync_meta.segmentGaps' });
    dropFirstSegment(a, b);
    const second = await b.cycle();
    expect(second.stateUnreadable ?? false).toBe(false);
    // Trou retrouvé par la règle (instantané essayé inchangé), jamais une reprise de plus.
    expect(statusOf(b, a.id)).toBe('corrupt');
    expect(resumes(b)).toBe(1);
  });

  it('ligne corrupt remise à active quand segmentGaps est illisible', async () => {
    const a = await deviceA();
    await a.data.repos.sync.saveState(B_ID, { status: 'corrupt' });
    await a.data.repos.sync.setMeta(META.segmentGaps, '{pas du json');
    expect((await a.cycle()).stateUnreadable).toBe(true);
    expect((await a.data.repos.sync.getStates()).find((r) => r.deviceId === B_ID)?.status).toBe('active');
    expect(await readJson(a.data.repos, META.segmentGaps)).toBeNull();
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });

  it('sync_meta.resumeTried corrompu : state-unreadable au premier cycle, lu comme absent, réécrit ; second cycle propre', async () => {
    const a = await deviceA();
    await a.data.repos.sync.setMeta(META.resumeTried, '{"epoch":42}');
    expect((await a.cycle()).stateUnreadable).toBe(true);
    expect(a.logger.entries.filter((e) => e.event === 'state-unreadable').map((e) => e.detail)).toContainEqual({ where: 'sync_meta.resumeTried' });
    expect(await readJson(a.data.repos, META.resumeTried)).toBeNull();
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });
});

describe('cinquième revue, point 1 : instantané essayé, jamais l’appliqué (ADR 0011 §5.5)', () => {
  const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const R_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  type Body = 'corrupt' | 'pending' | 'local';

  /**
   * A écrit T0 (j-1) ; C écrit un instantané (A couvert en j-1) ; A écrit T1 (j-2) ; B écrit le plus récent (A couvert en j-2). 40 jours
   * plus tard, R arrive ; chez lui j-1 de A manque (purgé), et le corps des instantanés `bodies` est illisible ou en attente.
   */
  async function room(bodies: Partial<Record<string, Body>>): Promise<{ a: SimDevice; b: SimDevice; c: SimDevice; r: SimDevice; deliver: () => void }> {
    const a = await deviceA();
    await a.createTask('T0');
    await a.cycle();
    const b = await deviceB(a);
    const c = await createSimDevice(C_ID, { name: 'C', clock: a.clock });
    devices.push(c);
    await pair(a, c);
    const all = [a, b, c];
    const sync = (): void => {
      for (const from of all) for (const to of all) if (from !== to) propagate(from.folder, to.folder, from.id);
    };
    for (let i = 0; i < 2; i += 1) {
      sync();
      for (const d of all) {
        d.clock.advance(1_000);
        await d.cycle();
      }
    }
    a.clock.advance(8 * DAY);
    sync();
    await c.cycle();
    expect(c.logger.entries.some((e) => e.event === 'snapshot-written')).toBe(true);
    // L'état de C (instantané annoncé) arrive partout : A n'en écrit pas un à lui.
    sync();
    a.clock.advance(DAY);
    refuseNextAppend(a);
    await a.createTask('T1');
    await a.cycle();
    a.clock.advance(8 * DAY);
    sync();
    await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'snapshot-written')).toBe(true);
    expect(a.logger.entries.some((e) => e.event === 'snapshot-written')).toBe(false);
    sync();
    a.clock.advance(40 * DAY);
    const r = await createSimDevice(R_ID, { name: 'R', clock: a.clock });
    devices.push(r);
    await pair(a, r);
    const deliver = (): void => {
      dropFirstSegment(a, r);
      propagate(b.folder, r.folder, b.id);
      propagate(c.folder, r.folder, c.id);
    };
    deliver();
    const real = r.platform.readSnapshot.bind(r.platform);
    r.platform.readSnapshot = async (request) => {
      const body = request.tail === true ? undefined : bodies[request.deviceId];
      if (body === 'corrupt') return { records: [], next: { segment: request.seq, record: 0 }, status: 'truncated' };
      if (body === 'pending') return { records: [], next: { segment: request.seq, record: 0 }, status: 'cloud-pending' };
      return real(request);
    };
    return { a, b, c, r, deliver };
  }
  const attempts = (d: SimDevice): number => d.logger.entries.filter((e) => e.event === 'resumed-from-snapshot' || e.event === 'resume-unavailable').length;

  it('corps de l’instantané de B illisible, celui de C appliqué : sur 5 cycles, une seule reprise, A corrupt', async () => {
    const { a, b, r, deliver } = await room({ [B_ID]: 'corrupt' });
    for (let i = 0; i < 5; i += 1) {
      deliver();
      r.clock.advance(60_000);
      await r.cycle();
      expect(statusOf(r, a.id), `cycle ${String(i)}`).toBe('corrupt');
    }
    expect(resumes(r)).toBe(1);
    expect(attempts(r)).toBe(1);
    expect(await readJson(r.data.repos, META.resumeTried)).toMatchObject({ author: b.id });
    expect(await readJson<Record<string, unknown>>(r.data.repos, META.segmentGaps)).toMatchObject({ [a.id]: { segment: 1, author: b.id } });
  });

  it('corps de l’instantané de B en attente d’iCloud (attente visible), puis arrivé : une reprise de plus, lecture complète, puis aucune', async () => {
    const bodies: Partial<Record<string, Body>> = { [B_ID]: 'pending' };
    const { a, r, deliver } = await room(bodies);
    deliver();
    expect((await r.cycle()).phase).toBe('waiting-icloud');
    expect(statusOf(r, a.id)).not.toBe('corrupt');
    bodies[B_ID] = 'local';
    const before = r.logger.entries.length;
    deliver();
    r.clock.advance(60_000);
    expect((await r.cycle()).phase).toBe('idle');
    expect(resumes(r, before)).toBe(1);
    expect(statusOf(r, a.id)).toBe('active');
    expect(await titlesOf(r)).toEqual(['T0', 'T1']);
    for (let i = 0; i < 3; i += 1) {
      deliver();
      r.clock.advance(60_000);
      await r.cycle();
    }
    expect(resumes(r, before)).toBe(1);
  });

  it('arrêt brutal après la fin de la reprise, avant l’enregistrement du trou : aucune seconde reprise', async () => {
    const { a, r, deliver } = await room({ [B_ID]: 'corrupt' });
    // Arrêt simulé : la reprise aboutit (sa dernière transaction écrit l'instantané essayé), le trou n'est pas encore enregistré.
    const realSave = r.data.repos.sync.saveState.bind(r.data.repos.sync);
    let armed = true;
    r.data.repos.sync.saveState = async (id, patch) => {
      if (armed && id === a.id && patch.status === 'corrupt') throw new Error('arrêt simulé');
      return realSave(id, patch);
    };
    await r.cycle().catch(() => undefined);
    armed = false;
    expect(resumes(r)).toBe(1);
    expect(await readJson(r.data.repos, META.resumeTried)).not.toBeNull();
    await r.restart();
    for (let i = 0; i < 3; i += 1) {
      deliver();
      r.clock.advance(60_000);
      await r.cycle();
    }
    expect(resumes(r)).toBe(1);
    expect(statusOf(r, a.id)).toBe('corrupt');
  });
});

describe('cinquième revue, point 3 : effacement du trou seulement à la lecture au-delà, au changement d’époque, à l’oubli ou au retrait', () => {
  it('listage de l’époque de A absent : trou gardé, rien n’est lu, fichier en attente visible', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    dropFirstSegment(a, b);
    b.folder.devices.get(a.id)?.epochs.clear();
    const status = await b.cycle();
    expect(status.phase).toBe('waiting-icloud');
    expect(statusOf(b, a.id)).toBe('corrupt');
    expect(await readJson<Record<string, unknown>>(b.data.repos, META.segmentGaps)).toHaveProperty(a.id);
  });

  it('A absent d’un scan (ligne gardée) : trou gardé ; A revenu : toujours corrupt', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    b.folder.devices.delete(a.id);
    await b.cycle();
    expect(await readJson<Record<string, unknown>>(b.data.repos, META.segmentGaps)).toHaveProperty(a.id);
    // A revenu : trou toujours là (B a pu écrire entre-temps un instantané à lui, éligible nouveau : une reprise de plus, permise).
    dropFirstSegment(a, b);
    await b.cycle();
    expect(statusOf(b, a.id)).toBe('corrupt');
    expect(await readJson<Record<string, unknown>>(b.data.repos, META.segmentGaps)).toHaveProperty(a.id);
  });

  it('A oublié : trou effacé', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    b.clock.advance(11 * 60_000);
    expect(await b.service.forgetDevice(a.id)).toEqual({ kind: 'done' });
    dropFirstSegment(a, b);
    await b.cycle();
    expect(await readJson(b.data.repos, META.segmentGaps)).toBeNull();
  });

  it('A retiré (plus de ligne sync_state, absent du dossier) : trou effacé', async () => {
    const [a, b] = await openingSnapshotGap();
    await b.cycle();
    b.folder.devices.delete(a.id);
    await b.driver.execute('DELETE FROM sync_state WHERE device_id = ?', [a.id]);
    await b.cycle();
    expect(await readJson(b.data.repos, META.segmentGaps)).toBeNull();
  });
});

describe('cinquième revue, point 4 : trou sur soi, hors règle', () => {
  it('reprise demandée, son propre j-1 absent : une reprise sur 3 cycles, self-segment-gap journalisé, aucune entrée pour soi, soi actif', async () => {
    const a = await deviceA();
    await a.createTask('T0');
    await a.cycle();
    refuseNextAppend(a);
    await a.createTask('T1');
    await a.cycle();
    a.folder.devices.get(a.id)?.epochs.get(epochOf(a))?.segments.delete(1);
    await a.data.repos.sync.setMeta(META.segmentGaps, JSON.stringify({ [a.id]: { epoch: epochOf(a), segment: 0, author: null, seq: null, since: '2026-10-05T08:00:00.000Z' } }));
    await a.data.repos.sync.setMeta(META.resume, 'true');
    const before = a.logger.entries.length;
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(60_000);
      await a.cycle();
      expect(await readJson<Record<string, unknown>>(a.data.repos, META.segmentGaps) ?? {}, `cycle ${String(i)}`).not.toHaveProperty(a.id);
    }
    expect(resumes(a, before)).toBe(1);
    expect(a.logger.entries.slice(before).filter((e) => e.event === 'self-segment-gap')).toHaveLength(1);
    expect((await a.data.repos.sync.getStates()).find((r) => r.deviceId === a.id)?.status).toBe('active');
    expect(await titlesOf(a)).toEqual(['T0', 'T1']);
  });
});

describe('cinquième revue, point 6 : entrée de l’auteur posée à l’annonce d’une réinitialisation', () => {
  it('tête sans hlc (aucune écriture publiée) : aucune entrée de l’auteur dans covers de l’instantané de la nouvelle époque', async () => {
    const a = await deviceA();
    const b = await deviceB(a);
    for (let i = 0; i < 3; i += 1) {
      propagate(a.folder, b.folder, a.id);
      propagate(b.folder, a.folder, b.id);
      a.clock.advance(1_000);
      await a.cycle();
      await b.cycle();
    }
    a.clock.advance(11 * 60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
    await a.cycle();
    const meta = await readJson<{ epoch: string; covers: Record<string, unknown> }>(a.data.repos, META.snapshot);
    expect(meta?.epoch).not.toBe(epochOf(b));
    expect(meta?.covers ?? {}).not.toHaveProperty(a.id);
  });
});
