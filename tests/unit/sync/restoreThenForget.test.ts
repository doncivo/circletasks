import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compareEpochs, epochId, type EpochId } from '../../../src/domain/sync/format';
import type { DeviceId } from '../../../src/domain/types';
import type { RestoreMarker } from '../../../src/platform/sync/types';
import { mirrorDeviceFolder, propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { B_ID as RESET_B, C_ID as RESET_C, closeAll, reassociate, settle as resetSettle, setupRoom, type Room } from './reset/resetKit';

/**
 * Y-TECH-01 (dettes, revue de Y-11) : restauration « Appliquer partout » puis oubli. Le mode `replace` du changement d'époque et
 * `applyEverywhere` remettaient toutes les lignes de `sync_state` à {époque cible, 0, 0} : un accusé « début de la nouvelle époque » était
 * publié sur un appareil qui n'y a rien publié. Oublié ensuite, sa coupure pouvait être relevée dans la nouvelle époque, où personne ne
 * peut plus le lire : condition (f) jamais remplie pour l'appareil qui le gardait à sa position de l'ancienne époque, suppression de ses
 * fichiers bloquée sans fin. Règle appliquée (même règle que Y-11, aucun accusé {époque, 0, 0} sur un appareil qui n'a rien publié
 * dans cette époque) : position de l'ancienne époque, celle de l'instantané d'ouverture (`covers`), jusqu'à sa première lecture dans la
 * nouvelle. Horloge simulée seulement.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const N_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function setup(): Promise<[SimDevice, SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
  const c = await createSimDevice(C_ID, { name: 'C', clock: a.clock });
  devices = [a, b, c];
  await setupFirst(a);
  expect((await a.cycle()).phase).toBe('idle');
  for (const d of [b, c]) {
    await pair(a, d);
    expect((await d.cycle()).phase).toBe('idle');
    syncFolders(devices);
  }
  await settle(devices);
  return [a, b, c];
}

async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r += 1) {
    for (const d of list) {
      syncFolders(list);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
  syncFolders(list);
}

/** Copie de la base (sauvegarde P-04) : toutes les tables. */
async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

/** Restauration P-04 de la copie, marqueur posé, puis « Appliquer cette version sur tous mes appareils ». */
async function restoreAndApplyEverywhere(device: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await device.driver.execute('PRAGMA foreign_keys = OFF');
  await device.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const [table, rows] of copy) {
      if (table === 'sync_guard' || table === 'schema_migrations') continue;
      await tx.execute(`DELETE FROM ${table}`);
      for (const row of rows as Record<string, string | number | null>[]) {
        const cols = Object.keys(row);
        await tx.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((col) => row[col] ?? null));
      }
    }
    await tx.execute('DELETE FROM sync_guard');
  });
  await device.driver.execute('PRAGMA foreign_keys = ON');
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261005.db', backupTakenAt: '2026-10-05T07:00:00.000Z' as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: 17 };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
  expect((await device.cycle()).phase).toBe('restore-choice');
  await device.service.chooseRestoreOption('apply-everywhere');
  expect(device.service.status().phase).toBe('idle');
}

interface Ack {
  readonly epoch: EpochId;
  readonly segment: number;
  readonly record: number;
}

function publishedAcks(of: SimDevice): Record<string, Ack> {
  const text = of.folder.devices.get(of.id)?.state?.lines[0]?.text;
  if (text === undefined) throw new Error(`aucun état publié par ${of.name}`);
  return (JSON.parse(text) as { acks: Record<string, Ack> }).acks;
}

function publishedEpoch(of: SimDevice, by: SimDevice): EpochId {
  const text = by.folder.devices.get(of.id)?.state?.lines[0]?.text;
  if (text === undefined) throw new Error(`état de ${of.name} absent chez ${by.name}`);
  return (JSON.parse(text) as { epoch: EpochId }).epoch;
}

/** Suppression faite par l'un : iCloud la propage aux autres. */
async function deleteForgotten(list: readonly SimDevice[], target: SimDevice): Promise<void> {
  for (let round = 0; round < 6 && list.every((d) => d.folder.devices.has(target.id)); round += 1) await settle(list, 1);
  const deleter = list.find((d) => !d.folder.devices.has(target.id));
  expect(deleter, 'aucun appareil n’a pu supprimer les fichiers de l’oublié').toBeDefined();
  for (const d of list) if (d !== deleter) mirrorDeviceFolder((deleter as SimDevice).folder, d.folder, target.id);
  await settle(list);
  for (const d of list) {
    expect(d.folder.devices.has(target.id), d.name).toBe(false);
    expect(d.service.status().forget?.deletions ?? [], d.name).toEqual([]);
  }
}

/** Nouvel appareil associé par `owner` : il arrive par l'instantané éligible et finit avec la même base. */
async function joinAndCompare(owner: SimDevice, others: readonly SimDevice[]): Promise<void> {
  const n = await createSimDevice(N_ID, { name: 'N', clock: owner.clock });
  devices.push(n);
  await pair(owner, n);
  const list = [...others, n];
  await settle(list);
  expect(n.service.status().phase).toBe('idle');
  for (const d of others) expect(await taskSnapshot(n), d.name).toEqual(await taskSnapshot(d));
}

describe('Y-TECH-01 : « Appliquer partout » puis oubli', () => {
  it('aucun accusé de la nouvelle époque sur un appareil qui n’y a rien publié ; oublié ensuite : coupure dans l’ancienne époque, fichiers supprimés, arrivée possible', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    // C n'est plus ouvert (perdu) ; A restaure sa sauvegarde et l'applique partout ; B suit la nouvelle époque par remplacement.
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    const e2 = epochId(2, a.id);
    expect(publishedEpoch(b, a)).toBe(e2);
    expect(compareEpochs(publishedEpoch(c, a), e2)).toBeLessThan(0);
    for (const d of [a, b]) {
      const ack = publishedAcks(d)[c.id];
      if (ack !== undefined) expect(compareEpochs(ack.epoch, e2), `${d.name} publie un accusé de ${e2} sur C`).toBeLessThan(0);
    }
    // A oublie C : coupure prise dans l'ancienne époque (position de l'instantané d'ouverture), la même chez A et B.
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    const onA = publishedAcks(a)[c.id];
    const onB = publishedAcks(b)[c.id];
    expect(onA).toBeDefined();
    expect(compareEpochs((onA as Ack).epoch, e2)).toBeLessThan(0);
    expect(onB).toEqual(onA);
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
  });

  it('oubli déclaré sur B avant qu’il lise la restauration de A : jamais bloqué (condition (f) remplie par tous)', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    // B oublie C (perdu) ; A n'a pas encore lu la déclaration quand il applique sa sauvegarde partout.
    expect(await b.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    const e2 = epochId(2, a.id);
    for (const d of [a, b]) {
      const ack = publishedAcks(d)[c.id];
      expect(ack, d.name).toBeDefined();
      expect(compareEpochs((ack as Ack).epoch, e2), `${d.name} publie un accusé de ${e2} sur C`).toBeLessThan(0);
    }
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
  });
});

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
const position = (ack: Ack | undefined): string | null => (ack === undefined ? null : `${ack.epoch}/${ack.segment}/${ack.record}`);

/**
 * C écrit C1 (lu par tous), puis C2 que seul B lit (B à `p_B`, A à `p_A < p_B`) ; C s'éteint. Rend la sauvegarde de A prise avant C2.
 */
async function splitPositions(a: SimDevice, b: SimDevice, c: SimDevice): Promise<Map<string, unknown[]>> {
  await c.createTask('C1');
  await settle([a, b, c]);
  const copy = await backupOf(a);
  await c.createTask('C2');
  c.clock.advance(1_000);
  await c.cycle();
  propagate(c.folder, b.folder, c.id);
  b.clock.advance(1_000);
  await b.cycle();
  expect(await titles(b)).toContain('C2');
  expect(await titles(a)).not.toContain('C2');
  return copy;
}

describe('Y-TECH-01, ADR 0011 §20 point 3 : l’accusé suit la base (simulations du point 4)', () => {
  it('(1) C oublié par B à p_B ; A, à p_A, applique partout ; B remplace : même coupure p_A partout, fichiers de C supprimés, N arrive, aucune écriture de C au-delà de p_A', async () => {
    const [a, b, c] = await setup();
    const copy = await splitPositions(a, b, c);
    const pA = position(publishedAcks(a)[c.id]);
    expect(await b.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    expect(position(publishedAcks(b)[c.id])).not.toBe(pA);
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    expect(position(publishedAcks(a)[c.id])).toBe(pA);
    expect(position(publishedAcks(b)[c.id])).toBe(pA);
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
    for (const d of devices.filter((x) => x !== c)) expect(await titles(d), d.name).not.toContain('C2');
  });

  it('(2) B hors ligne pendant la transition : attente visible (ligne « en attente »), aucun fichier de C supprimé, levée au retour de B', async () => {
    const [a, b, c] = await setup();
    const copy = await splitPositions(a, b, c);
    expect(await b.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    syncFolders([a, b]);
    await restoreAndApplyEverywhere(a, copy);
    // B est éteint : A seul tourne.
    for (let i = 0; i < 4; i += 1) {
      a.clock.advance(1_000);
      await a.cycle();
    }
    expect(a.folder.devices.has(c.id)).toBe(true);
    // A est lui-même en retard sur la coupure portée par B (p_B) : ligne « en attente », jamais une suppression.
    expect(a.service.status().forget?.deletions.map((d) => [d.deviceId, d.state])).toEqual([[c.id, 'waiting']]);
    // B revient, lit la restauration et remplace : l'attente cesse.
    await deleteForgotten([a, b], c);
  });

  it('(3) C terminé avant la restauration, A à la coupure : covers[C] ≥ coupure, aucun trou, aucune attente', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await deleteForgotten([a, b], c);
    const copy = await backupOf(a);
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    for (const d of [a, b]) {
      expect(d.logger.entries.some((e) => e.event === 'forget-gap'), d.name).toBe(false);
      expect(d.service.status().forget?.deletions ?? [], d.name).toEqual([]);
    }
    expect(position(publishedAcks(b)[c.id])).toBe(position(publishedAcks(a)[c.id]));
    await joinAndCompare(a, [a, b]);
  });

  it('(4) époques concurrentes : le perdant remplace, ses accusés sur C deviennent covers[C] du gagnant', async () => {
    const [a, b, c] = await setup();
    const copyB = await splitPositions(b, a, c);
    const copyA = await backupOf(a);
    // Ici A a lu C2, B non (B à p_B < p_A). A oublie C ; A et B appliquent chacun une sauvegarde partout sans se voir.
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await restoreAndApplyEverywhere(a, copyA);
    await restoreAndApplyEverywhere(b, copyB);
    const winner = b;
    const loser = a;
    await settle([a, b], 4);
    expect(publishedEpoch(loser, winner)).toBe(epochId(2, winner.id));
    const covered = position(publishedAcks(winner)[c.id]);
    expect(covered).not.toBeNull();
    expect(position(publishedAcks(loser)[c.id])).toBe(covered);
    await deleteForgotten([a, b], c);
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('Y-TECH-01, revue : instantané autre que celui d’ouverture', () => {
  it('B reprend depuis un instantané plus récent que l’ouverture : aucune position {e2, 0, 0} sur C ; A oublie C : suppression faite chez tous', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    await restoreAndApplyEverywhere(a, copy);
    await settle([a, b]);
    // Huit jours plus tard, A écrit l'instantané suivant ; B reprend depuis lui.
    a.clock.advance(8 * 86_400_000);
    await settle([a, b]);
    await b.data.repos.sync.setMeta('resume', 'true');
    await settle([a, b]);
    const e2 = epochId(2, a.id);
    const row = (await b.driver.select<{ epoch: string | null; cursor_segment: number; cursor_record: number }>('SELECT epoch, cursor_segment, cursor_record FROM sync_state WHERE device_id = ?', [c.id]))[0];
    expect(row?.epoch === e2 && row.cursor_segment === 0 && row.cursor_record === 0, 'B garde {e2, 0, 0} sur C').toBe(false);
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
  });

  it('B hors ligne pendant « Appliquer partout », revient après l’instantané suivant de A et remplace depuis lui ; A oublie C : suppression faite chez tous', async () => {
    const [a, b, c] = await setup();
    await c.createTask('C1');
    await settle([a, b, c]);
    const copy = await backupOf(a);
    await restoreAndApplyEverywhere(a, copy);
    // B est éteint ; huit jours plus tard A écrit l'instantané suivant.
    for (let i = 0; i < 2; i += 1) {
      a.clock.advance(4 * 86_400_000);
      await a.cycle();
    }
    await settle([a, b]);
    expect(publishedEpoch(b, a)).toBe(epochId(2, a.id));
    expect(position(publishedAcks(a)[c.id])).toBeNull();
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    expect(position(publishedAcks(b)[c.id])).toBe(position(publishedAcks(a)[c.id]));
    await deleteForgotten([a, b], c);
    await joinAndCompare(a, [a, b]);
  });
});

describe('Y-TECH-01, ADR 0011 §20 point 4 (5) : réinitialisation Y-11 (fusion), inchangé', () => {
  const room: Room = { devices: [] };
  afterEach(() => closeAll(room));

  it('(5) accusés figés en n gardés : le réassocié publie sur C oublié sa position de n, la même qu’avant (jamais covers ni {n+1, 0, 0})', async () => {
    const [a, b, c] = (await setupRoom(room, [RESET_B, RESET_C])) as [SimDevice, SimDevice, SimDevice];
    await c.createTask('C');
    await resetSettle(room.devices);
    const before = position(publishedAcks(b)[c.id]);
    expect(before).toMatch(/^e0001-/);
    expect((await a.service.resetSync()).kind).toBe('started');
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await reassociate(a, b, [a, b]);
    await b.cycle();
    const next = b.folder.devices.get(b.id)?.nextState?.lines[0]?.text;
    const ack = next ? (JSON.parse(next) as { acks: Record<string, Ack> }).acks[c.id] : undefined;
    expect(position(ack)).toBe(before);
    syncFolders([a, b]);
    await resetSettle([a, b], 3);
    expect(a.service.status().reset?.step).toBe('done');
  });
});
