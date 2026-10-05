import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_EXPIRY_MS } from '../../../../src/domain/sync/format';
import { newerDevices } from '../../../../src/domain/sync/compat';
import type { Hlc, TaskId } from '../../../../src/domain/types';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';
import { makeNewerDevice, markNewerMajor, NEXT_SV, TEST_COLUMN, upgradeDevice } from '../../../sim/syncVersions';

/**
 * Deux versions de l'app sur le banc (Y-07 critères 2, 3, 5, 7, 8, 9 et 11 ; recette de ce que Y2 a livré) : A publie une version de
 * schéma plus récente (colonne `x` inconnue de B), B la garde sans l'effacer, la reporte dans ses instantanés, la réintègre après sa mise
 * à jour ; une majeure supérieure suspend la lecture de cet appareil seulement.
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

/** B (version de l'app courante) ouvre le dossier ; A s'y associe puis devient « plus récent » ; tout le monde est à jour. */
async function olderAndNewer(options: { sv?: number; xFor?: (id: string) => string | null } = {}): Promise<{ a: SimDevice; b: SimDevice; xValues: Map<string, string> }> {
  const b = await createSimDevice(B_ID, { name: 'PC' });
  const a = await createSimDevice(A_ID, { name: 'iPhone', clock: b.clock });
  devices = [a, b];
  await setupFirst(b);
  expect((await b.cycle()).phase).toBe('idle');
  await pair(b, a);
  const xValues = new Map<string, string>();
  makeNewerDevice(a, { appVersion: '0.5.0', ...(options.sv === undefined ? {} : { sv: options.sv }), xFor: options.xFor ?? ((id) => xValues.get(id) ?? null) });
  expect((await a.cycle()).phase).toBe('idle');
  syncFolders(devices);
  await b.cycle();
  return { a, b, xValues };
}

const unknownOf = (d: SimDevice) => d.driver.select<{ table_name: string; row_id: string; field: string; value: string; hlc: string; sv: number }>('SELECT table_name, row_id, field, value, hlc, sv FROM sync_unknown ORDER BY table_name, row_id, field');
const ownJournalText = (d: SimDevice): string =>
  [...(d.folder.devices.get(d.id)?.epochs.values() ?? [])].flatMap((e) => [...e.segments.values()].flatMap((f) => f.lines.map((l) => l.text))).join('\n');

describe('version de schéma plus récente (Y-07 critères 2, 7, 9, 11)', () => {
  it('B lit les champs connus, garde x dans sync_unknown (paramètres liés, sv de A), voit A « plus récent » sans suspendre la lecture', async () => {
    const { a, b, xValues } = await olderAndNewer();
    xValues.set('pending', '');
    const task = await a.createTask('Venue de la version suivante');
    xValues.set(task.id, 'valeur de A');
    b.clock.advance(1_000);
    await a.cycle();
    syncFolders(devices);
    const status = await b.cycle();
    expect((await b.task(task.id))?.title).toBe('Venue de la version suivante');
    const kept = await unknownOf(b);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ table_name: 'task', row_id: task.id, field: TEST_COLUMN, value: JSON.stringify('valeur de A'), sv: NEXT_SV });
    // D4 : la phase reste celle d'une synchro normale ; seule une majeure supérieure donne update-required.
    expect(status.phase).toBe('idle');
    const deviceA = status.devices.find((d) => d.deviceId === A_ID);
    expect(deviceA).toMatchObject({ status: 'active', newer: 'schema', appVersion: '0.5.0' });
    expect(newerDevices(status.devices).map((d) => d.deviceId)).toEqual([A_ID]);
    // Critère 11 : la ligne de soi n'a pas de champ de version.
    const self = status.devices.find((d) => d.self);
    expect(self?.newer).toBeUndefined();
    expect(self?.appVersion).toBeUndefined();
    // Aucun journal technique ne porte la valeur d'un champ inconnu.
    expect(JSON.stringify(b.logger.entries)).not.toContain('valeur de A');
  });

  it('A voit B plus ancien : aucun appareil « plus récent » de son côté (pas de bandeau sur l’appareil à jour)', async () => {
    const { a } = await olderAndNewer();
    const status = await a.cycle();
    const deviceB = status.devices.find((d) => d.deviceId === B_ID);
    expect(deviceB?.newer).toBeNull();
    expect(deviceB?.appVersion).toBe('0.4.0');
    expect(newerDevices(status.devices)).toEqual([]);
  });

  it('critère 7 : B mis à jour (colonne x, migration rejouée) : la tâche porte x, horloge de A, sync_outbox vide, B ne republie pas x', async () => {
    const { a, b, xValues } = await olderAndNewer();
    const task = await a.createTask('Avec x');
    xValues.set(task.id, 'valeur de A');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    const keptHlc = (await unknownOf(b))[0]?.hlc as Hlc;
    expect(keptHlc.endsWith(A_ID)).toBe(true);
    const journalBefore = ownJournalText(b);

    const report = await upgradeDevice(b);
    expect(report).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    expect(await b.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [task.id])).toEqual([{ x: 'valeur de A' }]);
    expect(await b.driver.select("SELECT hlc, base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = ? AND field = ?", [task.id, TEST_COLUMN])).toEqual([{ hlc: keptHlc, base_hlc: null }]);
    expect(await b.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(await b.driver.select('SELECT * FROM sync_guard')).toEqual([]);
    expect(await unknownOf(b)).toEqual([]);

    // Cycle suivant de B : rien à publier, son journal ne contient pas x.
    await b.cycle();
    expect(ownJournalText(b)).toBe(journalBefore);
    expect(ownJournalText(b)).not.toContain(`"${TEST_COLUMN}"`);
    // Second démarrage : sans effet (rejouable).
    expect(await upgradeDevice(b)).toEqual({ reintegrated: 0, superseded: 0, remaining: 0 });
  });

  it('critère 9 : A absent depuis plus de 180 jours (expired) : il ne compte plus pour « Mettez à jour l’app »', async () => {
    const { b } = await olderAndNewer();
    expect(newerDevices((await b.cycle()).devices)).toHaveLength(1);
    b.clock.advance(DEVICE_EXPIRY_MS + DAY);
    const status = await b.cycle();
    expect(status.devices.find((d) => d.deviceId === A_ID)?.status).toBe('expired');
    expect(newerDevices(status.devices)).toEqual([]);
  });
});

describe('champ inconnu d’une version égale ou plus ancienne (Y-07 critère 3, recette Y2)', () => {
  it.each([
    ['égale', SCHEMA_VERSION],
    ['plus ancienne', SCHEMA_VERSION - 1],
  ])('version %s : refusé, journalisé sans contenu (table, motif), absent de sync_unknown ; les champs connus passent', async (_label, sv) => {
    const { a, b, xValues } = await olderAndNewer({ sv });
    const task = await a.createTask('Même version');
    xValues.set(task.id, 'ne doit pas rester');
    await a.cycle();
    syncFolders(devices);
    const status = await b.cycle();
    expect((await b.task(task.id))?.title).toBe('Même version');
    expect(await unknownOf(b)).toEqual([]);
    const rejected = b.logger.entries.filter((e) => e.event === 'apply-rejected');
    expect(rejected.length).toBeGreaterThan(0);
    for (const entry of rejected) {
      expect(entry.detail).toEqual({ table: 'task', reason: 'unknown-field' });
    }
    expect(JSON.stringify(b.logger.entries)).not.toContain('ne doit pas rester');
    expect(JSON.stringify(b.logger.entries)).not.toContain(`"${TEST_COLUMN}"`);
    expect(newerDevices(status.devices)).toEqual([]);
  });
});

describe('instantanés (Y-07 critère 5, recette Y2)', () => {
  it('A récent publie x, B ancien le garde et écrit un instantané, C récent lit l’instantané de B : C retrouve x', async () => {
    const { a, b, xValues } = await olderAndNewer();
    const task = await a.createTask('Pour C');
    xValues.set(task.id, 'valeur de A');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    const keptHlc = (await unknownOf(b))[0]?.hlc;
    // Une semaine plus tard, B (seul à faire un cycle) écrit un instantané qui porte le champ gardé.
    b.clock.advance(8 * DAY);
    await b.cycle();
    const snapshotText = [...(b.folder.devices.get(B_ID)?.epochs.values() ?? [])].flatMap((e) => [...e.snapshots.values()].flatMap((f) => f.lines.map((l) => l.text))).join('\n');
    expect(snapshotText).toContain('snap-unknown');
    expect(snapshotText).toContain('valeur de A');

    // C, version récente (colonne x), rejoint par l'instantané de B.
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: b.clock });
    devices.push(c);
    await upgradeDevice(c);
    await pair(b, c);
    propagate(a.folder, c.folder, A_ID);
    await c.cycle();
    expect((await c.task(task.id as TaskId))?.title).toBe('Pour C');
    // Démarrage suivant de C (crochet de fin du migrateur) : x réintégré, horloge de A.
    expect((await upgradeDevice(c)).reintegrated).toBe(1);
    expect(await c.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [task.id])).toEqual([{ x: 'valeur de A' }]);
    expect(await c.driver.select("SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = ? AND field = ?", [task.id, TEST_COLUMN])).toEqual([{ hlc: keptHlc }]);
    expect(await c.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
  });
});

describe('majeure supérieure (Y-07 critère 8)', () => {
  it('lecture de cet appareil suspendue (curseur figé, rien appliqué), publication locale et lecture des autres continuent', async () => {
    const b = await createSimDevice(B_ID, { name: 'PC' });
    const a = await createSimDevice(A_ID, { name: 'iPhone', clock: b.clock });
    const c = await createSimDevice(C_ID, { name: 'Tablette', clock: b.clock });
    devices = [a, b, c];
    await setupFirst(b);
    await b.cycle();
    await pair(b, a);
    await a.cycle();
    syncFolders(devices);
    await pair(b, c);
    await c.cycle();
    syncFolders(devices);
    await b.cycle();
    const cursorOf = async () => (await b.data.repos.sync.getStates()).find((r) => r.deviceId === A_ID);
    const before = await cursorOf();

    // A passe à une majeure supérieure et publie ; C publie normalement ; B écrit localement.
    const fromA = await a.createTask('Majeure 2');
    await a.cycle();
    const fromC = await c.createTask('De C');
    await c.cycle();
    propagate(a.folder, b.folder, A_ID);
    markNewerMajor(b.folder, A_ID);
    propagate(c.folder, b.folder, C_ID);
    const fromB = await b.createTask('De B');
    b.clock.advance(1_000);
    const status = await b.cycle();

    expect(status.phase).toBe('update-required');
    expect(await b.task(fromA.id)).toBeNull();
    const after = await cursorOf();
    expect({ segment: after?.cursorSegment, record: after?.cursorRecord, ack: after?.ackHlc }).toEqual({ segment: before?.cursorSegment, record: before?.cursorRecord, ack: before?.ackHlc });
    expect(after?.status).toBe('newer-major');
    expect((await b.task(fromC.id))?.title).toBe('De C');
    expect(ownJournalText(b)).toContain(fromB.id);
    const deviceA = status.devices.find((d) => d.deviceId === A_ID);
    // État illisible : le numéro d'application connu est celui de l'ancienne version, il n'est pas montré.
    expect(deviceA).toMatchObject({ status: 'newer-major', newer: 'major', appVersion: null });
    expect(status.devices.find((d) => d.deviceId === C_ID)).toMatchObject({ status: 'active', newer: null });
    expect(newerDevices(status.devices).map((d) => d.deviceId)).toEqual([A_ID]);

    // L'appareil plus récent lit toujours la majeure plus ancienne (B, sm 1).
    syncFolders([b, a]);
    await a.cycle();
    expect((await a.task(fromB.id))?.title).toBe('De B');
  });
});
