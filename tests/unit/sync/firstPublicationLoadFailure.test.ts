import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusLine } from '../../../src/features/sync/syncText';
import { armCrash } from '../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-FIX-02, revue M3 : le bloc à la demande `orphanEpoch` (borne locale, journal `publish-deferred`, reprise d'`inflight`) ne se charge pas.
 * Le cycle échoue avec le code `io`, visible (phase d'erreur, jamais « À jour ») ; l'intention et la file sont gardées pour le cycle suivant.
 * `publish-blocked` n'est pas levé dans ce cas (l'erreur passe avant) : accepté par la revue, noté dans la fiche. Le chargement du bloc
 * échoue pour tout ce fichier : aucun cycle de mise en place n'en a besoin (première publication ordinaire).
 */
vi.mock('../../../src/sync/orphanEpoch', () => {
  throw new Error('chargement du bloc orphanEpoch impossible');
});

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function joined(): Promise<SimDevice> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  await a.createTask('Tâche PC');
  await a.cycle();
  await pair(a, b);
  await b.createTask('Écrite sur l’iPhone');
  return b;
}

/** Rangs du premier ajout et du premier état qui le suit (comptés sans arrêt). */
async function ranks(): Promise<{ append: number; state: number }> {
  const b = await joined();
  const probe = armCrash(b, null);
  const platform = b.platform as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let append: number | null = null;
  let state: number | null = null;
  for (const name of ['appendJournal', 'writeState'] as const) {
    const real = platform[name] as (...args: unknown[]) => Promise<unknown>;
    platform[name] = (...args) => {
      if (name === 'appendJournal' && append === null) append = probe.writes + 1;
      if (name === 'writeState' && append !== null && state === null) state = probe.writes + 1;
      return real.apply(b.platform, args);
    };
  }
  await b.cycle();
  probe.disarm();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  if (append === null || state === null) throw new Error('premier cycle sans ajout ni état');
  return { append, state };
}

async function crashAt(rank: number): Promise<SimDevice> {
  const b = await joined();
  const probe = armCrash(b, rank);
  await b.cycle();
  expect(probe.crashed).toBe(true);
  probe.disarm();
  await b.restart();
  return b;
}

describe('bloc orphanEpoch impossible à charger (revue M3)', () => {
  it('borne locale (arrêt P3) : cycle en échec io, visible, jamais « À jour », aucun état écrit', async () => {
    const b = await crashAt((await ranks()).state);
    const before = b.logger.entries.length;
    const s = await b.cycle();
    expect(s.phase).toBe('error');
    expect(s.errorCode).toBe('io');
    expect(statusLine(s, b.clock.nowMs())).not.toContain('À jour');
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'cycle-failed').map((e) => e.detail)).toEqual([{ code: 'io' }]);
  });

  it('reprise d’inflight (arrêt P1) : cycle en échec io, intention et file gardées', async () => {
    const b = await crashAt((await ranks()).append);
    const inflight = await b.data.repos.sync.getMeta('inflight');
    const queued = await b.data.repos.sync.outboxCount();
    expect(inflight).not.toBeNull();
    const s = await b.cycle();
    expect(s.phase).toBe('error');
    expect(s.errorCode).toBe('io');
    expect(await b.data.repos.sync.getMeta('inflight')).toBe(inflight);
    expect(await b.data.repos.sync.outboxCount()).toBe(queued);
  });

  it('refus ordinaire sans trace (état supprimé après publication, cas joinAfterRecords) : cycle en échec io, visible ; les autres appareils ne sont pas lus ce cycle-là', async () => {
    const b = await createSimDevice(B_ID, { name: 'iPhone' });
    devices.push(b);
    await setupFirst(b);
    expect((await b.cycle()).phase).toBe('idle');
    const own = b.folder.devices.get(b.id);
    if (own) own.state = null;
    const before = b.logger.entries.length;
    const s = await b.cycle();
    expect(s.phase).toBe('error');
    expect(s.errorCode).toBe('io');
    expect(statusLine(s, b.clock.nowMs())).not.toContain('À jour');
    expect(b.folder.fileNames(b.id)).not.toContain('state.ctx');
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'publish-deferred')).toHaveLength(0);
  });
});
