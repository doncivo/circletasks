import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STATE_REFRESH_MS } from '../../../src/domain/sync/format';
import type { DeviceId } from '../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-01, QA : nombre d'écritures de `state.ctx` par cycle à 2, 3 et 4 appareils (actifs ou non, avec écritures locales, avec un appareil
 * hors ligne qui revient, avec un oubli en cours) et convergence identique partout. Horloge injectée (aucun délai réel) : un cycle de chaque
 * appareil toutes les 5 minutes, iCloud recopié après chaque cycle. Les bornes sont déduites de la règle (une écriture locale = au plus une
 * republication par appareil au cycle même, plus le rafraîchissement de 30 minutes), jamais élargies pour faire passer un test.
 */

const IDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'] as const;
const CYCLE_MS = 5 * 60_000;
const TICKS_PER_REFRESH = STATE_REFRESH_MS / CYCLE_MS;

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

class Counter {
  readonly byDevice = new Map<string, number>();
  constructor(list: readonly SimDevice[]) {
    for (const d of list) {
      this.byDevice.set(d.id, 0);
      const original = d.platform.writeState.bind(d.platform);
      d.platform.writeState = async (request) => {
        await original(request);
        this.byDevice.set(d.id, (this.byDevice.get(d.id) ?? 0) + 1);
      };
    }
  }
  of(d: SimDevice): number {
    return this.byDevice.get(d.id) ?? 0;
  }
  total(): number {
    return [...this.byDevice.values()].reduce((s, n) => s + n, 0);
  }
}

async function associated(count: number): Promise<SimDevice[]> {
  const first = await createSimDevice(IDS[0], { name: 'A' });
  const list = [first];
  devices = list;
  for (const id of IDS.slice(1, count)) list.push(await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: first.clock }));
  await setupFirst(first);
  expect((await first.cycle()).phase).toBe('idle');
  for (const joiner of list.slice(1)) {
    await pair(first, joiner);
    expect((await joiner.cycle()).phase).toBe('idle');
    syncFolders(list);
  }
  for (let i = 0; i < 3; i += 1) {
    for (const d of list) await d.cycle();
    syncFolders(list);
  }
  return list;
}

/** Un tour : 5 minutes, puis un cycle de chaque appareil de `active`, iCloud recopié entre eux après chacun. */
async function tick(active: readonly SimDevice[], mirror: readonly SimDevice[] = active): Promise<void> {
  (active[0] as SimDevice).clock.advance(CYCLE_MS);
  for (const d of active) {
    expect((await d.cycle()).phase, d.name).toBe('idle');
    syncFolders(mirror);
  }
}

async function expectIdentical(list: readonly SimDevice[]): Promise<void> {
  const expected = await taskSnapshot(list[0] as SimDevice);
  for (const d of list) expect(await taskSnapshot(d), d.name).toEqual(expected);
}

describe.each([2, 3, 4])('Y-TECH-01 QA : %i appareils actifs', (count) => {
  const TICKS = 36; // trois heures
  const REFRESHES = Math.ceil(TICKS / TICKS_PER_REFRESH) + 1;

  it('écritures locales (une tous les 3 tours, appareils à tour de rôle) : au plus une republication par appareil et par écriture, plus le rafraîchissement ; bases identiques', async () => {
    const list = await associated(count);
    const counter = new Counter(list);
    let local = 0;
    for (let t = 0; t < TICKS; t += 1) {
      // Une écriture tous les 3 tours : sans la correction, chaque appareil réécrirait à chaque tour (36), pas 12 + rafraîchissements.
      if (t % 3 === 0) {
        await (list[t % count] as SimDevice).createTask(`Tâche ${String(t)}`);
        local += 1;
      }
      await tick(list);
    }
    for (const d of list) expect(counter.of(d), `${d.name} : ${String(counter.of(d))} écritures pour ${String(local)} écritures locales`).toBeLessThanOrEqual(local + REFRESHES);
    const before = counter.total();
    await tick(list);
    await tick(list);
    expect(counter.total() - before, 'deux tours calmes après les écritures').toBeLessThanOrEqual(count);
    await expectIdentical(list);
  });

  it('écritures simultanées de tous les appareils dans un même tour, puis une heure calme : aucun va-et-vient', async () => {
    const list = await associated(count);
    const counter = new Counter(list);
    for (let t = 0; t < 6; t += 1) {
      for (const d of list) await d.createTask(`${d.name}${String(t)}`);
      await tick(list);
    }
    const quiet = counter.total();
    for (let t = 0; t < 12; t += 1) await tick(list);
    // 12 tours calmes = 1 heure = au plus 2 rafraîchissements par appareil, plus 1 d'alignement.
    expect(counter.total() - quiet).toBeLessThanOrEqual(count * 3);
    await expectIdentical(list);
  });

  it('inactifs : au plus un rafraîchissement par appareil toutes les 30 minutes (plus un), jamais une écriture par tour', async () => {
    const list = await associated(count);
    const counter = new Counter(list);
    const quietTicks = TICKS_PER_REFRESH * 4;
    for (let t = 0; t < quietTicks; t += 1) await tick(list);
    for (const d of list) expect(counter.of(d), d.name).toBeLessThanOrEqual(4 + 1);
  });
});

describe('Y-TECH-01 QA : appareil hors ligne qui revient', () => {
  it.each([3, 4])('%i appareils : le dernier est absent 4 heures, les autres écrivent ; au retour, convergence et retour au calme', async (count) => {
    const list = await associated(count);
    const away = list[count - 1] as SimDevice;
    const present = list.slice(0, count - 1);
    const counter = new Counter(list);
    let local = 0;
    for (let t = 0; t < 48; t += 1) {
      if (t % 4 === 0) {
        await (present[t % present.length] as SimDevice).createTask(`Présent ${String(t)}`);
        local += 1;
      }
      await tick(present);
    }
    for (const d of present) expect(counter.of(d), `${d.name} pendant l'absence`).toBeLessThanOrEqual(local + Math.ceil(48 / TICKS_PER_REFRESH) + 1);
    expect(counter.of(away)).toBe(0);
    await away.createTask('Écrite hors ligne');
    syncFolders(list);
    const before = counter.total();
    for (let t = 0; t < 3; t += 1) await tick(list);
    expect(counter.total() - before, 'trois tours de retour').toBeLessThanOrEqual(count * 4);
    await expectIdentical(list);
    const settled = counter.total();
    await tick(list);
    await tick(list);
    expect(counter.total() - settled, 'plus de va-et-vient après le retour').toBeLessThanOrEqual(count);
  });
});

describe('Y-TECH-01 QA : oubli en cours', () => {
  it('A oublie D (éteint) à 4 appareils : la liste maître est republiée par chacun, puis aucune réécriture hors rafraîchissement', async () => {
    const list = await associated(4);
    const [a, b, c, d] = list as [SimDevice, SimDevice, SimDevice, SimDevice];
    const live = [a, b, c];
    await tick(list);
    const counter = new Counter(live);
    expect(await a.service.forgetDevice(d.id as DeviceId)).toEqual({ kind: 'done' });
    for (let t = 0; t < 24; t += 1) await tick(live);
    const forgotten = (of: SimDevice): string[] => ((JSON.parse(of.folder.devices.get(of.id)?.state?.lines[0]?.text ?? '{}') as { forgotten?: { deviceId: string }[] }).forgotten ?? []).map((f) => f.deviceId);
    for (const x of live) expect(forgotten(x), x.name).toEqual([d.id]);
    // 24 tours = 2 heures : 4 rafraîchissements, la déclaration ou son apprentissage, les accusés de la suppression des fichiers (marge de 3).
    for (const x of live) expect(counter.of(x), x.name).toBeLessThanOrEqual(1 + 4 + 3);
    await expectIdentical(live);
  });
});
