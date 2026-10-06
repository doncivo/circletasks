import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { STATE_REFRESH_MS } from '../../../src/domain/sync/format';
import type { DeviceId } from '../../../src/domain/types';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-01 (dettes, revue de Y-10 point 6) : entre appareils actifs qui se lisent, `state.ctx` ne doit pas être réécrit à chaque cycle.
 * Avant la correction, l'accusé publié porte le `stateSeq` de l'état lu de l'autre appareil et ce champ entrait dans la comparaison
 * « réécrit seulement s'il a changé » (section 1.4) : chaque écriture changeait l'accusé de l'autre, qui réécrivait à son tour, sans fin
 * (mesuré avant : 71 et 72 réécritures pour 72 cycles à deux appareils, 72 pour chacun des trois ; après : 12, soit une par 30 minutes).
 * Les changements qu'une règle attend restent publiés au cycle même (positions lues, liste maître, accusé attendu par un état illisible).
 * Horloge simulée seulement (aucun délai réel) : un cycle toutes les 5 minutes en premier plan, iCloud recopié entre deux cycles.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CYCLE_MS = 5 * 60_000;

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Compte les appels réussis à `writeState` (une écriture iCloud et un nonce chacun) de chaque appareil. */
function countStateWrites(list: readonly SimDevice[]): Map<string, number> {
  const counts = new Map<string, number>(list.map((d) => [d.id, 0]));
  for (const d of list) {
    const original = d.platform.writeState.bind(d.platform);
    d.platform.writeState = async (request) => {
      await original(request);
      counts.set(d.id, (counts.get(d.id) ?? 0) + 1);
    };
  }
  return counts;
}

interface PublishedJson {
  readonly stateSeq: number;
  readonly acks: Record<string, { readonly stateSeq: number }>;
  readonly forgotten: readonly { readonly deviceId: string }[];
}

/** `state.ctx` publié par `of`, tel qu'il est dans son propre dossier (texte clair gardé par la plateforme mémoire). */
function published(of: SimDevice): PublishedJson {
  const text = of.folder.devices.get(of.id)?.state?.lines[0]?.text;
  if (text === undefined) throw new Error(`aucun état publié par ${of.name}`);
  return JSON.parse(text) as PublishedJson;
}

async function associated(ids: readonly string[]): Promise<SimDevice[]> {
  const first = await createSimDevice(ids[0] as string, { name: (ids[0] as string).slice(0, 1).toUpperCase() });
  const list = [first];
  for (const id of ids.slice(1)) list.push(await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: first.clock }));
  devices = list;
  await setupFirst(first);
  expect((await first.cycle()).phase).toBe('idle');
  for (const joiner of list.slice(1)) {
    await pair(first, joiner);
    expect((await joiner.cycle()).phase).toBe('idle');
    syncFolders(list);
  }
  // Mise en route : chacun lit chacun (accusés posés partout), puis l'état est stable.
  for (let i = 0; i < 3; i += 1) {
    for (const d of list) await d.cycle();
    syncFolders(list);
  }
  return list;
}

/** Un tour : 5 minutes d'horloge simulée, puis un cycle de chaque appareil, iCloud recopié après chacun. */
async function tick(list: readonly SimDevice[]): Promise<void> {
  (list[0] as SimDevice).clock.advance(CYCLE_MS);
  for (const d of list) {
    expect((await d.cycle()).phase, d.name).toBe('idle');
    syncFolders(list);
  }
}

async function run(list: readonly SimDevice[], cycles: number): Promise<void> {
  for (let i = 0; i < cycles; i += 1) await tick(list);
}

describe('Y-TECH-01 : état publié réécrit seulement s\'il a changé, entre appareils actifs', () => {
  // Six heures en premier plan : 72 cycles par appareil. Rafraîchissement de 30 minutes : 12 réécritures au plus par appareil.
  const CYCLES = (6 * 60 * 60_000) / CYCLE_MS;
  const BOUND = (CYCLES * CYCLE_MS) / STATE_REFRESH_MS;

  it('deux appareils inactifs : une réécriture par appareil toutes les 30 minutes au plus, jamais une par cycle', async () => {
    const list = await associated([A_ID, B_ID]);
    const writes = countStateWrites(list);
    await run(list, CYCLES);
    for (const d of list) expect(writes.get(d.id), d.name).toBeLessThanOrEqual(BOUND);
    expect(await taskSnapshot(list[1] as SimDevice)).toEqual(await taskSnapshot(list[0] as SimDevice));
  });

  it('trois appareils inactifs : même borne', async () => {
    const list = await associated([A_ID, B_ID, C_ID]);
    const writes = countStateWrites(list);
    await run(list, CYCLES);
    for (const d of list) expect(writes.get(d.id), d.name).toBeLessThanOrEqual(BOUND);
  });

  it('une écriture : son auteur et le lecteur (position lue) republient au cycle même, puis plus rien jusqu\'au rafraîchissement', async () => {
    const [a, b] = (await associated([A_ID, B_ID])) as [SimDevice, SimDevice];
    // Hors de la fenêtre du rafraîchissement : un tour juste après la mise en route.
    await tick([a, b]);
    const writes = countStateWrites([a, b]);
    await a.createTask('Écrite sur A');
    await tick([a, b]);
    expect(writes.get(a.id)).toBe(1);
    expect(writes.get(b.id)).toBe(1);
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
    // B a publié sa nouvelle position sur A au cycle même (purge « lu par tous », coupure, précondition de Y-11).
    expect(published(b).acks[a.id]?.stateSeq).toBe(published(a).stateSeq);
    await tick([a, b]);
    await tick([a, b]);
    expect(writes.get(a.id)).toBe(1);
    expect(writes.get(b.id)).toBe(1);
  });

  it('liste maître qui grandit : republiée au cycle même par l\'appareil qui l\'apprend (condition (f) de Y-10)', async () => {
    const [a, b, c] = (await associated([A_ID, B_ID, C_ID])) as [SimDevice, SimDevice, SimDevice];
    await tick([a, b, c]);
    // C n'est plus ouvert ; A l'oublie.
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    expect(published(a).forgotten.map((f) => f.deviceId)).toEqual([c.id]);
    expect(published(b).forgotten).toEqual([]);
    propagate(a.folder, b.folder, a.id);
    b.clock.advance(CYCLE_MS);
    await b.cycle();
    // Rien d'autre n'a changé pour B (aucun enregistrement nouveau, rafraîchissement pas dû) : la liste maître est republiée au cycle même.
    expect(published(b).forgotten.map((f) => f.deviceId)).toEqual([c.id]);
  });

  it('état de l\'autre appareil rejoué : le stateSeq de l\'accusé est republié aussitôt (borne de la règle 1), une fois', async () => {
    const [a, b] = (await associated([A_ID, B_ID])) as [SimDevice, SimDevice];
    const old = b.folder.takeState(b.id);
    const writesOfB = countStateWrites([b]);
    // B se réécrit au rafraîchissement ; A l'accepte au tour suivant sans republier (seul le stateSeq de son accusé a changé).
    let guard = 0;
    while (writesOfB.get(b.id) === 0 && guard < 12) {
      await tick([a, b]);
      guard += 1;
    }
    expect(writesOfB.get(b.id)).toBe(1);
    await tick([a, b]);
    const latest = published(b).stateSeq;
    expect(published(a).acks[b.id]?.stateSeq).toBeLessThan(latest);
    // Un ancien état de B est relivré chez A (iCloud, ou un tiers) : A l'écarte (rollback) et publie aussitôt l'accusé à jour.
    a.folder.putState(old);
    const writesOfA = countStateWrites([a]);
    a.clock.advance(CYCLE_MS);
    await a.cycle();
    expect(a.service.status().devices.find((d) => d.deviceId === b.id)?.status).toBe('rollback');
    expect(writesOfA.get(a.id)).toBe(1);
    expect(published(a).acks[b.id]?.stateSeq).toBe(latest);
    // Une fois : l'état rejoué ne change rien d'autre, A ne republie plus à chaque cycle.
    a.clock.advance(CYCLE_MS);
    await a.cycle();
    expect(writesOfA.get(a.id)).toBe(1);
  });
});

/**
 * B se réécrit au rafraîchissement ; A l'accepte sans republier (seul le stateSeq de son accusé sur B a changé). Rend l'ancien état de B
 * et le `stateSeq` de son dernier état.
 */
async function staleAckOnB(a: SimDevice, b: SimDevice): Promise<{ old: ReturnType<SimDevice['folder']['takeState']>; latest: number }> {
  const old = b.folder.takeState(b.id);
  const writesOfB = countStateWrites([b]);
  for (let guard = 0; writesOfB.get(b.id) === 0 && guard < 12; guard += 1) await tick([a, b]);
  expect(writesOfB.get(b.id)).toBe(1);
  await tick([a, b]);
  const latest = published(b).stateSeq;
  expect(published(a).acks[b.id]?.stateSeq).toBeLessThan(latest);
  return { old, latest };
}

/** Copie de l'état de B chiffrée sous une autre clé (en-tête d'un autre `kid`) : `foreign`. */
function foreignCopy(of: SimDevice): ReturnType<SimDevice['folder']['takeState']> {
  const copy = of.folder.takeState(of.id);
  if (!copy.file) throw new Error('aucun état');
  return { ...copy, file: { ...copy.file, header: { ...copy.file.header, kid: '0123456789abcdef' } } };
}

describe('Y-TECH-01 (revue, point 5) : accusé republié aussitôt pour chaque état illisible (AWAITING_ACK_SEQ), jamais pour cloud-pending', () => {
  const cases: readonly [string, (a: SimDevice, b: SimDevice, old: ReturnType<SimDevice['folder']['takeState']>) => void, boolean][] = [
    ['missing', (a, b) => a.folder.removeFile(b.id, 'state.ctx'), true],
    ['foreign', (a, b) => a.folder.putState(foreignCopy(b)), true],
    ['corrupt', (a, b) => a.folder.corruptRecord(b.id, 'state.ctx', 0), true],
    ['rollback', (a, _b, old) => a.folder.putState(old), true],
    ['too-large', (a, b) => a.folder.addBytes(b.id, 'state.ctx', 1_000_000), true],
    ['cloud-pending', (a, b) => a.folder.setAvailability(b.id, 'state.ctx', 'cloud'), false],
  ];
  it.each(cases)('%s', async (_status, damage, rewrites) => {
    const [a, b] = (await associated([A_ID, B_ID])) as [SimDevice, SimDevice];
    const { old, latest } = await staleAckOnB(a, b);
    damage(a, b, old);
    const writesOfA = countStateWrites([a]);
    a.clock.advance(CYCLE_MS);
    await a.cycle();
    expect(writesOfA.get(a.id)).toBe(rewrites ? 1 : 0);
    if (rewrites) expect(published(a).acks[b.id]?.stateSeq).toBe(latest);
    // Une seule fois.
    a.clock.advance(CYCLE_MS);
    await a.cycle();
    expect(writesOfA.get(a.id)).toBe(rewrites ? 1 : 0);
  });

  it('reconstruction (iii) de forgotten.json : B, état remplacé par un tiers et registre perdu, republie dès le cycle suivant de A', async () => {
    const [a, b] = (await associated([A_ID, B_ID])) as [SimDevice, SimDevice];
    await staleAckOnB(a, b);
    const foreign = foreignCopy(b);
    a.folder.putState(foreign);
    b.folder.putState(foreign);
    b.platform.testing.dropForgottenFile();
    b.clock.advance(CYCLE_MS);
    // Aucun accusé de A sur B n'atteint encore le stateSeq de own.json : B ne peut pas reconstruire sa liste (visible, jamais silencieux).
    expect((await b.cycle()).phase).toBe('error');
    await a.cycle();
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(b.platform.testing.forgottenRegistry()).not.toBeNull();
  });
});

describe('Y-TECH-01 (revue, point 4) : état absent puis reconstruit à deux appareils', () => {
  it('B perd son state.ctx et own.json : stateSeq reconstruit depuis les accusés, éventuellement en retard ; réparé seul en quelques cycles', async () => {
    const [a, b] = (await associated([A_ID, B_ID])) as [SimDevice, SimDevice];
    await staleAckOnB(a, b);
    b.folder.removeFile(b.id, 'state.ctx');
    b.platform.testing.dropOwnState();
    syncFolders([a, b]);
    const task = await b.createTask('Après la reconstruction');
    for (let i = 0; i < 4; i += 1) await tick([a, b]);
    expect(a.service.status().devices.find((d) => d.deviceId === b.id)?.status).toBe('active');
    expect((await a.task(task.id))?.title).toBe('Après la reconstruction');
    expect(published(a).acks[b.id]?.stateSeq).toBe(published(b).stateSeq);
  });
});
