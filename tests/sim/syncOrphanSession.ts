import { expect } from 'vitest';
import type { EpochId } from '../../src/domain/sync/format';
import type { TaskId } from '../../src/domain/types';
import { propagate } from './syncCloudSim';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, type SimDevice } from './syncDevice';

/**
 * Y-TECH-03 (B13), scénario 1 du banc : état réel de l'iPhone du 8 octobre et de la séance 0.3.2 (B1, ADR 0011 §24 point 10), reconstruit
 * avec le plan de pannes au lieu d'une plateforme truquée : l'iPhone `ef50…` a abandonné son époque orpheline `e0001-ef50…`, suit l'époque du
 * PC `e0001-56d4…` et lit son journal, n'a jamais publié d'état (`stateSeq` 0, cycle coupé avant tout segment et avant `state.ctx` par des
 * écritures refusées en `io`), le mémo `orphanEpoch` est perdu et `devices/ef50…/e0001-ef50…/s-00000001.cts` est le seul fichier de son
 * dossier. Même construction que `aliState` de tests/unit/sync/pairing/orphanRelisted.test.ts (Y-IOS-02-FIX-02), pannes comprises.
 */

export const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const PC_EPOCH = `e0001-${A_ID}` as EpochId;
export const ORPHAN = `e0001-${B_ID}` as EpochId;
/** L'instantané orphelin, nom relatif au dossier de l'iPhone. */
export const ORPHAN_SNAPSHOT = `${ORPHAN}/s-00000001.cts`;

export interface OrphanSession {
  readonly a: SimDevice;
  readonly b: SimDevice;
  readonly testPc: TaskId;
  readonly localIphone: TaskId;
}

/** Époque `ef50` ouverte par l'iPhone (0.2.3) : instantané 1 de sa base, `sync_meta` comme après `epoch-opened`, aucun état. */
async function seedOrphan(b: SimDevice): Promise<void> {
  await b.platform.bindDevice(b.id);
  const end = '{"k":"snap-end","count":0,"covers":{},"epoch":"' + ORPHAN + '","sv":' + String(SCHEMA_VERSION) + '}';
  await b.platform.writeSnapshot({
    epoch: ORPHAN,
    seq: 1,
    sv: SCHEMA_VERSION,
    records: (async function* () {
      yield [end];
    })(),
  });
  await b.data.repos.sync.clearOutbox(await b.data.repos.sync.maxOutboxSeq());
  await b.data.repos.sync.setMeta('epoch', JSON.stringify(ORPHAN));
  await b.data.repos.sync.setMeta('head', JSON.stringify({ epoch: ORPHAN, segment: 0, record: 0, hlc: null, stateSeq: 0 }));
  await b.data.repos.sync.setMeta('snapshot', JSON.stringify({ epoch: ORPHAN, seq: 1, endHlc: b.hlc.now() }));
  await b.restart();
}

/** Construit l'état de la séance ; `devices` reçoit les deux appareils (fermés par l'appelant). */
export async function orphanSession(devices: SimDevice[], memo: 'lost' | 'kept' = 'lost'): Promise<OrphanSession> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  for (let i = 0; i < 3; i += 1) await a.createTask(`Tâche PC ${String(i)}`);
  await a.cycle();
  const testPc = (await a.createTask('Test Pc')).id as TaskId;
  await a.cycle();
  await pair(a, b);
  a.clock.advance(3_600_000);
  await a.updateTask(testPc, { carriedOver: true });
  await a.cycle();
  const localIphone = (await b.createTask('Écrite sur l’iPhone')).id as TaskId;
  await seedOrphan(b);
  propagate(a.folder, b.folder, a.id);
  // Premier cycle 0.2.3/0.3.0 : abandon, arrivée dans 56d4 et lecture faits ; ni segment ni état écrits (écritures refusées par iCloud).
  b.folder.armFaults({
    name: 'premier-cycle-coupe',
    faults: [
      { id: 'segment-refuse', op: 'write', file: `devices/${B_ID}/*/j-*.ctj`, nth: 1, times: 'all', effect: 'error', code: 'io' },
      { id: 'etat-refuse', op: 'write', file: `devices/${B_ID}/state.ctx`, nth: 1, times: 'all', effect: 'error', code: 'io' },
    ],
  });
  await b.cycle();
  expect(b.folder.faultLog().map((f) => f.id)).toContain('etat-refuse');
  b.folder.disarmFaults();
  await b.restart();
  expect(b.logger.entries.some((e) => e.event === 'epoch-abandoned')).toBe(true);
  expect((await b.task(testPc))?.carriedOver).toBe(true);
  if (memo === 'lost') await b.data.repos.sync.setMeta('orphanEpoch', null);
  // État exact constaté sur l'iPhone.
  expect(await b.data.repos.sync.getMeta('epoch')).toBe(JSON.stringify(PC_EPOCH));
  expect(JSON.parse((await b.data.repos.sync.getMeta('orphanEpoch')) ?? 'null')).toEqual(memo === 'lost' ? null : { epoch: ORPHAN });
  expect(JSON.parse((await b.data.repos.sync.getMeta('stateSeq')) ?? '0') ?? 0).toBe(0);
  expect(b.folder.fileNames(b.id)).toEqual([ORPHAN_SNAPSHOT]);
  propagate(b.folder, a.folder, b.id);
  b.logger.entries.length = 0;
  return { a, b, testPc, localIphone };
}

/** Nombre d'entrées d'un événement au journal du moteur. */
export const events = (d: SimDevice, event: string): number => d.logger.entries.filter((e) => e.event === event).length;

/** Ce que le scénario observe, cycle par cycle (journal, avertissements, dossier de l'iPhone). */
export interface OrphanObservation {
  readonly cycles: readonly { readonly events: readonly string[]; readonly warnings: readonly string[]; readonly phase: string; readonly line: string; readonly ownFiles: readonly string[] }[];
  readonly deleteFailures: readonly unknown[];
  readonly pcReadIphone: boolean;
}

/**
 * Rejoue le scénario 1 du banc : plan de pannes armé sur le dossier de l'iPhone, `cycles` cycles de l'iPhone (dossiers recopiés entre
 * chaque), puis un cycle du PC. `statusText` : texte de la ligne d'état (statusLine de l'interface), injecté pour garder ce module sans
 * dépendance à l'interface.
 */
export async function playOrphanScenario(s: OrphanSession, plan: unknown, statusText: (status: Awaited<ReturnType<SimDevice['cycle']>>, nowMs: number) => string, cycles = 3): Promise<OrphanObservation> {
  const { a, b, localIphone } = s;
  b.folder.armFaults(plan);
  const out: OrphanObservation['cycles'][number][] = [];
  for (let i = 0; i < cycles; i += 1) {
    const before = b.logger.entries.length;
    const status = await b.cycle();
    out.push({
      events: b.logger.entries.slice(before).map((e) => e.event),
      warnings: [...(status.warnings ?? [])],
      phase: status.phase,
      line: statusText(status, b.clock.nowMs()),
      ownFiles: b.folder.fileNames(b.id),
    });
    propagate(b.folder, a.folder, b.id);
    propagate(a.folder, b.folder, a.id);
  }
  await a.cycle();
  return {
    cycles: out,
    deleteFailures: b.logger.entries.filter((e) => e.event === 'orphan-epoch-delete-failed').map((e) => e.detail),
    pcReadIphone: (await a.task(localIphone))?.title === 'Écrite sur l’iPhone',
  };
}

/**
 * Attentes du scénario 1 (critère 19 a), rendues comme une liste d'écarts (vide : scénario vert) pour que la preuve de détection (19 b)
 * puisse constater qu'il devient rouge avec l'ancienne règle sans désactiver aucune attente.
 */
export function orphanScenarioViolations(obs: OrphanObservation): string[] {
  const out: string[] = [];
  const all = obs.cycles.flatMap((c) => c.events);
  const relisted = all.indexOf('orphan-epoch-relisted');
  const deleted = all.indexOf('orphan-epoch-deleted');
  if (relisted < 0) out.push('orphan-epoch-relisted absent');
  if (deleted < 0 || deleted < relisted) out.push('orphan-epoch-deleted absent ou avant le réarmement');
  const last = obs.cycles.at(-1);
  if (!last || last.ownFiles.some((f) => f.startsWith(`${ORPHAN}/`))) out.push('dossier orphelin toujours présent');
  if (!last?.ownFiles.includes('state.ctx')) out.push('publication jamais reprise (aucun state.ctx)');
  if (last?.warnings.includes('publish-blocked')) out.push('publish-blocked au dernier cycle');
  if (last?.events.includes('publish-deferred')) out.push('publish-deferred au dernier cycle (dure)');
  if (!last?.line.includes('À jour')) out.push(`ligne d'état du dernier cycle : ${last?.line ?? 'aucune'}`);
  if (!obs.pcReadIphone) out.push('le PC ne lit pas la tâche de l’iPhone');
  return out;
}
