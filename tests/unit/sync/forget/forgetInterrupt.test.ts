import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { FORGET_META } from '../../../../src/sync/forget';
import { armCrash } from '../../../sim/syncCrash';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10 critère 14 (ADR 0011 §14.2, §9 règle 1) : un oubli interrompu à **chaque** écriture du scénario (intention du moteur, déclaration
 * de Rust dans `forgotten.json`, transactions et état publié des deux cycles, suppression des fichiers) reprend sans perte et sans
 * doublon : au redémarrage, `forgotten.json` (Rust) fait foi et le moteur republie. Si l'arrêt a eu lieu avant la déclaration de Rust,
 * rien n'a été écrit : l'utilisateur recommence. État final identique à celui d'une exécution sans arrêt.
 *
 * Aucun délai : l'arrêt est un compteur d'écritures (`tests/sim/syncCrash.ts`, même méthode que `joinInterrupt.test.ts`).
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** A et X associés, une tâche de chacun lue par l'autre. */
async function scenario(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  const x = await createSimDevice(X_ID, { name: 'X', clock: a.clock });
  devices = [a, x];
  await setupFirst(a);
  await a.cycle();
  await pair(a, x);
  await x.cycle();
  await a.createTask('Tâche A');
  await x.createTask('Tâche X');
  for (let i = 0; i < 3; i += 1) {
    syncFolders(devices);
    a.clock.advance(1_000);
    await a.cycle();
    await x.cycle();
  }
  return [a, x];
}

interface Outcome {
  readonly declared: readonly string[];
  readonly published: readonly string[];
  readonly xFolderOnA: boolean;
  readonly titles: readonly string[];
  readonly failure: unknown;
  readonly publishPending: unknown;
  readonly forgetStatus: unknown;
  readonly xStatus: string | undefined;
}

async function outcome(a: SimDevice, x: SimDevice): Promise<Outcome> {
  const state = JSON.parse(a.folder.devices.get(a.id)?.state?.lines[0]?.text ?? '{}') as { forgotten?: { deviceId: string }[] };
  return {
    declared: a.platform.testing.forgottenDeclarations().map((d) => d.deviceId),
    published: (state.forgotten ?? []).map((f) => f.deviceId),
    xFolderOnA: a.folder.devices.has(x.id),
    titles: (await a.driver.select<{ title: string }>('SELECT title FROM task ORDER BY title')).map((r) => r.title),
    failure: await a.data.repos.sync.getMeta(FORGET_META.failure),
    publishPending: await a.data.repos.sync.getMeta(FORGET_META.publish),
    forgetStatus: a.service.status().forget ?? null,
    xStatus: a.service.status().devices.find((d) => d.deviceId === x.id)?.status,
  };
}

/** Reprise après un arrêt : redémarrage, un cycle ; l'utilisateur recommence si rien n'avait été déclaré ; puis deux cycles. */
async function resume(a: SimDevice, x: SimDevice): Promise<void> {
  await a.restart();
  a.clock.advance(1_000);
  await a.cycle();
  if (a.platform.testing.forgottenDeclarations().length === 0) expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
  for (let i = 0; i < 2; i += 1) {
    a.clock.advance(1_000);
    await a.cycle();
  }
}

describe('oubli interrompu à chaque écriture (critère 14)', () => {
  /** Écritures de A pendant « Oublier X » (intention, déclaration, deux cycles et la suppression) sans arrêt ; mesurées. */
  const WRITES = 27;

  it('référence : sans arrêt, l’oubli fait exactement WRITES écritures (sinon ajuster la borne) et finit oublié, publié une fois, fichiers supprimés', async () => {
    const [a, x] = await scenario();
    const probe = armCrash(a, null);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    probe.disarm();
    expect(probe.writes).toBe(WRITES);
    await resume(a, x);
    expect(await outcome(a, x)).toEqual(REFERENCE);
  });

  const REFERENCE: Outcome = {
    declared: [X_ID],
    published: [X_ID],
    xFolderOnA: false,
    titles: ['Tâche A', 'Tâche X'],
    failure: null,
    publishPending: null,
    forgetStatus: null,
    xStatus: 'forgotten',
  };

  for (let n = 1; n <= WRITES; n += 1) {
    it(`arrêt avant l’écriture ${String(n)} : reprise sans perte ni doublon, état final identique`, async () => {
      const [a, x] = await scenario();
      const crash = armCrash(a, n);
      await a.service.forgetDevice(x.id as DeviceId);
      expect(crash.crashed).toBe(true);
      crash.disarm();
      await resume(a, x);
      expect(await outcome(a, x)).toEqual(REFERENCE);
    });
  }
});
