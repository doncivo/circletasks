import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../../src/db/migrations';
import { migrate } from '../../../src/db/migrator';
import { isTroublePhase, statusLine } from '../../../src/features/sync/syncText';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { makeNewerDevice, NEXT_MIGRATION, TEST_COLUMN, upgradeDevice } from '../../sim/syncVersions';

/**
 * I-06 critère 15 (Y-07 critère 6, dette « échec de réintégration ») sur l'iPhone : une ligne de `sync_unknown` qui ne peut pas être
 * réintégrée après la mise à jour garde la synchro active et reste visible (ligne de Réglages, état « problème » qui alimente le bandeau
 * Y-07) ; elle disparaît après une réintégration réussie au démarrage suivant.
 */

const PC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PHONE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('réintégration en échec après la mise à jour de l’iPhone (critère 15)', () => {
  it('visible et persistante sur l’iPhone, synchro active ; effacée après une réintégration réussie', async () => {
    const pc = await createSimDevice(PC_ID, { name: 'PC' });
    const phone = await createSimDevice(PHONE_ID, { name: 'iPhone', clock: pc.clock, devicePlatform: 'ios' });
    devices = [pc, phone];
    await setupFirst(pc);
    await pc.cycle();
    await pair(pc, phone);
    const values = new Map<string, string>();
    makeNewerDevice(pc, { appVersion: '0.3.0', xFor: (id) => values.get(id) ?? null });
    await pc.cycle();
    const task = await pc.createTask('Avec x');
    values.set(task.id, 'valeur du PC');
    await pc.cycle();
    syncFolders(devices);
    await phone.cycle();
    expect(await phone.driver.select('SELECT field FROM sync_unknown')).toEqual([{ field: TEST_COLUMN }]);

    // Mise à jour de l'iPhone ; une contrainte de la nouvelle version refuse la valeur reçue.
    await migrate(phone.driver, [...migrations, NEXT_MIGRATION]);
    await phone.driver.execute(`CREATE TRIGGER test_refuse_x BEFORE UPDATE OF ${TEST_COLUMN} ON task WHEN NEW.${TEST_COLUMN} = 'valeur du PC' BEGIN SELECT RAISE(ABORT, 'refus'); END`);
    expect((await upgradeDevice(phone)).remaining).toBe(1);
    await phone.restart();
    let status = await phone.cycle();
    expect(status.devices.find((d) => d.self)?.platform).toBe('ios');
    expect(status.reintegrationFailure).toMatchObject({ fields: 1, tables: ['task'] });
    expect(statusLine(status, phone.clock.nowMs())).toBe('1 élément reçu d’une version plus récente n’a pas pu être intégré');
    expect(isTroublePhase(status)).toBe(true);
    expect(JSON.stringify(status)).not.toContain('valeur du PC');
    // La synchro reste active : une tâche créée sur le PC arrive quand même.
    const later = await pc.createTask('Après l’échec');
    await pc.cycle();
    syncFolders(devices);
    status = await phone.cycle();
    expect((await phone.task(later.id))?.title).toBe('Après l’échec');
    expect(status.reintegrationFailure?.fields).toBe(1);

    // Démarrage suivant, contrainte levée : réintégré, plus rien d'affiché.
    await phone.driver.execute('DROP TRIGGER test_refuse_x');
    expect((await upgradeDevice(phone)).remaining).toBe(0);
    await phone.restart();
    status = await phone.cycle();
    expect(status.reintegrationFailure ?? null).toBeNull();
    expect(isTroublePhase(status)).toBe(false);
  });
});
