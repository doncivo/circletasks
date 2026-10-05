import { afterEach, describe, expect, it } from 'vitest';
import { newerDevices } from '../../../../src/domain/sync/compat';
import { propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';
import { makeNewerDevice, markNewerMajor, NEXT_SV, TEST_COLUMN, upgradeDevice } from '../../../sim/syncVersions';

/**
 * QA Y-07 : trois versions de l'app en même temps (A sv+2, B sv+1, C sv) et majeure supérieure répétée. Aucun délai réel : l'horloge du
 * banc est manuelle, les dossiers sont copiés à la main.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

const unknownOf = (d: SimDevice) => d.driver.select<{ row_id: string; field: string; value: string; sv: number }>('SELECT row_id, field, value, sv FROM sync_unknown ORDER BY row_id, field');

/** C (sv courant) ouvre le dossier ; B (sv+1) et A (sv+2) le rejoignent ; chacun publie `x` sur ses tâches selon sa table. */
async function threeVersions(): Promise<{ a: SimDevice; b: SimDevice; c: SimDevice; xA: Map<string, string>; xB: Map<string, string> }> {
  const c = await createSimDevice(C_ID, { name: 'Tablette' });
  const b = await createSimDevice(B_ID, { name: 'PC', clock: c.clock });
  const a = await createSimDevice(A_ID, { name: 'iPhone', clock: c.clock });
  devices = [a, b, c];
  await setupFirst(c);
  await c.cycle();
  await pair(c, b);
  await pair(c, a);
  const xA = new Map<string, string>();
  const xB = new Map<string, string>();
  makeNewerDevice(b, { sv: NEXT_SV, appVersion: '0.5.0', xFor: (id) => xB.get(id) ?? null });
  makeNewerDevice(a, { sv: NEXT_SV + 1, appVersion: '0.6.0', xFor: (id) => xA.get(id) ?? null });
  for (const d of [a, b]) {
    expect((await d.cycle()).phase).toBe('idle');
    syncFolders(devices);
  }
  return { a, b, c, xA, xB };
}

describe('trois versions : A sv+2, B sv+1, C sv (Y-07 critères 2, 3, 5, 9, 11, QA)', () => {
  it('chaque appareil ne voit « plus récent » que les appareils de sv supérieur ; aucune lecture suspendue', async () => {
    const { a, b, c } = await threeVersions();
    syncFolders(devices);
    const fromC = await c.cycle();
    const fromB = await b.cycle();
    const fromA = await a.cycle();
    const relation = (status: typeof fromC, id: string) => status.devices.find((d) => d.deviceId === id)?.newer;
    expect([relation(fromC, A_ID), relation(fromC, B_ID)]).toEqual(['schema', 'schema']);
    expect([relation(fromB, A_ID), relation(fromB, C_ID)]).toEqual(['schema', null]);
    expect([relation(fromA, B_ID), relation(fromA, C_ID)]).toEqual([null, null]);
    expect(newerDevices(fromC.devices).map((d) => d.deviceId).sort()).toEqual([A_ID, B_ID]);
    expect(newerDevices(fromB.devices).map((d) => d.deviceId)).toEqual([A_ID]);
    expect(newerDevices(fromA.devices)).toEqual([]);
    for (const status of [fromA, fromB, fromC]) expect(status.phase).toBe('idle');
    // Les numéros d'application publiés sont ceux de chaque appareil, jamais un numéro de migration.
    expect(fromC.devices.find((d) => d.deviceId === A_ID)?.appVersion).toBe('0.6.0');
    expect(fromC.devices.find((d) => d.deviceId === B_ID)?.appVersion).toBe('0.5.0');
  });

  it('x publié par A (sv+2) est gardé par B (sv+1) et C (sv) avec le sv de A ; la valeur au plus grand hlc gagne, quel que soit l’ordre d’arrivée', async () => {
    const { a, b, c, xA, xB } = await threeVersions();
    const task = await c.createTask('Commune');
    await c.cycle();
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    xA.set(task.id, 'valeur A');
    await a.updateTask(task.id, { note: 'a' });
    await a.cycle();
    c.clock.advance(1_000);
    xB.set(task.id, 'valeur B (plus récente)');
    await b.updateTask(task.id, { note: 'b' });
    await b.cycle();

    // C lit B puis A : la valeur de B (hlc plus grand) est gardée, bien que A ait un sv plus grand.
    propagate(b.folder, c.folder, B_ID);
    propagate(a.folder, c.folder, A_ID);
    await c.cycle();
    const kept = await unknownOf(c);
    expect(kept).toEqual([{ row_id: task.id, field: TEST_COLUMN, value: JSON.stringify('valeur B (plus récente)'), sv: NEXT_SV }]);

    // B lit A seul : le x de A (sv+2 > sv+1) est gardé, sans effacer le sien (publié par xFor, jamais écrit dans sa base).
    propagate(a.folder, b.folder, A_ID);
    await b.cycle();
    const keptByB = await unknownOf(b);
    expect(keptByB.map((r) => r.sv)).toEqual([NEXT_SV + 1]);
    expect(keptByB[0]?.value).toBe(JSON.stringify('valeur A'));

    // Mise à jour de C : la valeur la plus récente (B) est réintégrée, rien n'est republié.
    expect((await upgradeDevice(c)).reintegrated).toBe(1);
    expect(await c.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [task.id])).toEqual([{ x: 'valeur B (plus récente)' }]);
    expect(await c.driver.select("SELECT field FROM sync_outbox WHERE field = 'x'")).toEqual([]);
  });

  it('B (sv+1) ne garde pas un champ inconnu reçu de C (sv, plus ancien) : refusé sans contenu', async () => {
    const { b, c } = await threeVersions();
    // C n'a pas de colonne x : on simule un C fautif en lui faisant publier x comme une version plus ancienne le ferait.
    makeNewerDevice(c, { sv: NEXT_SV - 1, appVersion: '0.3.0', xFor: () => 'ne doit pas rester' });
    await c.createTask('Fautive');
    await c.cycle();
    syncFolders(devices);
    await b.cycle();
    expect(await unknownOf(b)).toEqual([]);
    expect(JSON.stringify(b.logger.entries)).not.toContain('ne doit pas rester');
  });
});

describe('majeure supérieure (Y-07 critère 8, QA)', () => {
  it('plusieurs cycles : curseur et accusé immobiles, aucune donnée de A appliquée à moitié ; publication locale et lecture des autres continuent', async () => {
    const { a, b, c } = await threeVersions();
    const task = await c.createTask('Avant');
    await c.cycle();
    syncFolders(devices);
    await b.cycle();
    await a.cycle();
    syncFolders(devices);
    const cursorOf = async () => {
      const r = (await b.data.repos.sync.getStates()).find((s) => s.deviceId === A_ID);
      return { segment: r?.cursorSegment, record: r?.cursorRecord, ack: r?.ackHlc, status: r?.status };
    };
    const before = await cursorOf();
    await a.updateTask(task.id, { title: 'A passe en majeure 2' });
    const fresh = await a.createTask('Créée par A en majeure 2');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID);
    markNewerMajor(b.folder, A_ID);

    for (let i = 0; i < 3; i += 1) {
      b.clock.advance(60_000);
      const own = await b.createTask(`B ${String(i)}`);
      const fromC = await c.createTask(`C ${String(i)}`);
      await c.cycle();
      propagate(c.folder, b.folder, C_ID);
      const status = await b.cycle();
      expect(status.phase).toBe('update-required');
      expect(await b.task(fresh.id)).toBeNull();
      expect((await b.task(task.id))?.title).toBe('Avant');
      expect((await b.task(fromC.id))?.title).toBe(`C ${String(i)}`);
      expect({ ...(await cursorOf()), status: undefined }).toEqual({ ...before, status: undefined });
      expect((await cursorOf()).status).toBe('newer-major');
      // La publication de B continue : C la lit.
      propagate(b.folder, c.folder, B_ID);
      await c.cycle();
      expect((await c.task(own.id))?.title).toBe(`B ${String(i)}`);
      expect(await unknownOf(b)).toEqual([]);
      const deviceA = status.devices.find((d) => d.deviceId === A_ID);
      expect(deviceA).toMatchObject({ status: 'newer-major', newer: 'major' });
      expect(newerDevices(status.devices).map((d) => d.deviceId)).toEqual([A_ID]);
    }
  });

  it('un appareil de majeure supérieure n’alimente jamais sync_unknown ni les réglages de B', async () => {
    const { a, b } = await threeVersions();
    await a.createTask('Majeure 2');
    await a.cycle();
    propagate(a.folder, b.folder, A_ID);
    markNewerMajor(b.folder, A_ID);
    await b.cycle();
    expect(await unknownOf(b)).toEqual([]);
    expect(await b.driver.select('SELECT * FROM sync_parked')).toEqual([]);
  });
});
