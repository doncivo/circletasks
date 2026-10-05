import { afterEach, describe, expect, it } from 'vitest';
import { migrations } from '../../../../src/db/migrations';
import { migrate } from '../../../../src/db/migrator';
import { isTroublePhase, statusLine } from '../../../../src/features/sync/syncText';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';
import { makeNewerDevice, NEXT_MIGRATION, TEST_COLUMN, upgradeDevice } from '../../../sim/syncVersions';

/**
 * Exigence d'Ali (2026-10-05) : un échec de réintégration est visible dans l'app et survit au redémarrage ; il s'efface dès qu'un
 * démarrage réussit ; une attente (ligne ou parent pas encore arrivés) n'affiche rien.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** A (plus récent) publie une tâche avec x ; B (ancien) la garde ; B reçoit ensuite la migration de x, sans réintégrer encore. */
async function keptOnB(): Promise<{ a: SimDevice; b: SimDevice; taskId: string }> {
  const b = await createSimDevice(B_ID, { name: 'PC' });
  const a = await createSimDevice(A_ID, { name: 'iPhone', clock: b.clock });
  devices = [a, b];
  await setupFirst(b);
  await b.cycle();
  await pair(b, a);
  const values = new Map<string, string>();
  makeNewerDevice(a, { xFor: (id) => values.get(id) ?? null });
  await a.cycle();
  const task = await a.createTask('Avec x');
  values.set(task.id, 'valeur de A');
  await a.cycle();
  syncFolders(devices);
  await b.cycle();
  await migrate(b.driver, [...migrations, NEXT_MIGRATION]);
  return { a, b, taskId: task.id };
}

describe('échec de réintégration visible (exigence d’Ali)', () => {
  it('échec persistant : visible dans Réglages (état « problème ») après redémarrage ; un démarrage réussi l’efface', async () => {
    const { b, taskId } = await keptOnB();
    // Contrainte d'une migration future qui refuse la valeur reçue.
    await b.driver.execute(`CREATE TRIGGER test_refuse_x BEFORE UPDATE OF ${TEST_COLUMN} ON task WHEN NEW.${TEST_COLUMN} = 'valeur de A' BEGIN SELECT RAISE(ABORT, 'refus'); END`);
    expect((await upgradeDevice(b)).remaining).toBe(1);

    await b.restart();
    let status = await b.cycle();
    expect(status.reintegrationFailure).toMatchObject({ fields: 1, tables: ['task'], errors: ['DbError'] });
    expect(statusLine(status, b.clock.nowMs())).toBe('1 élément reçu d’une version plus récente n’a pas pu être intégré');
    expect(isTroublePhase(status)).toBe(true);
    expect(JSON.stringify(status)).not.toContain('valeur de A');

    // Second démarrage, toujours en échec : toujours visible.
    expect((await upgradeDevice(b)).remaining).toBe(1);
    await b.restart();
    status = await b.cycle();
    expect(status.reintegrationFailure?.fields).toBe(1);

    // La contrainte est levée : le démarrage suivant réintègre, plus rien d'affiché.
    await b.driver.execute('DROP TRIGGER test_refuse_x');
    expect(await upgradeDevice(b)).toEqual({ reintegrated: 1, superseded: 0, remaining: 0 });
    await b.restart();
    status = await b.cycle();
    expect(status.reintegrationFailure ?? null).toBeNull();
    expect(isTroublePhase(status)).toBe(false);
    expect(statusLine(status, b.clock.nowMs())).toMatch(/^À jour/);
    expect(await b.driver.select(`SELECT ${TEST_COLUMN} AS x FROM task WHERE id = ?`, [taskId])).toEqual([{ x: 'valeur de A' }]);
  });

  it('attente (ligne pas encore arrivée) : rien d’affiché', async () => {
    const { b } = await keptOnB();
    await b.driver.execute("INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) SELECT table_name, '99999999-0000-4000-8000-000000000009', field, value, hlc, base_hlc, sv FROM sync_unknown");
    const report = await upgradeDevice(b);
    expect(report.remaining).toBe(1);
    await b.restart();
    const status = await b.cycle();
    expect(status.reintegrationFailure ?? null).toBeNull();
    expect(isTroublePhase(status)).toBe(false);
  });
});
