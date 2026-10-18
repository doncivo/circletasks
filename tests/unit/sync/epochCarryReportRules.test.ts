import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/db/driver';
import { EPOCH_CARRY_REPORT_FAILED_EVENT, EPOCH_CARRY_REPORT_FAILED_META, type EpochCarryReport } from '../../../src/domain/sync/epochCarryReport';
import { syncTable } from '../../../src/domain/sync/syncTables';
import type { DeviceId, IsoDateTime } from '../../../src/domain/types';
import { clearEpochCarryNoticeFailure } from '../../../src/sync/carryNoticeState';
import { setEpochSwitchTestHooks, type SwitchStep } from '../../../src/sync/epochSwitch';
import { acknowledgeEpochCarryReport } from '../../../src/sync/epochCarryReportAck';
import { armCrash, type CrashProbe } from '../../sim/syncCrash';
import { syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { closeAll, reassociate, settle, setupRoom, B_ID as RESET_B, type Room } from './reset/resetKit';
import { A_ID, B_ID, P_ID, applyEverywhere, backupOf, projectP, readByBoth, rounds, rowsOf, tasksUnder, twoDevices } from './epochCarryKit';

/**
 * Y-TECH-05 : règles du compte rendu sur le banc à deux appareils (sauvegarde de A, restauration « Appliquer partout », B reporte).
 * Critère 6 : arrêt brutal à chaque borne de page de `reapply` : compte rendu identique à une exécution sans arrêt.
 * Critère 7 : fusion (réinitialisation Y-11) : listes vides, sans bandeau. Critère 8 : rien à reporter : compte rendu à zéro, sans bandeau.
 * Critère 9 : troisième liste (parent remplacé, Y-FIX-04), y compris une notice antérieure. Critère 11 : 501 lignes nommées sur le banc.
 * Critère 14 : écriture du compte rendu refusée : données reportées comme sans panne, échec visible ; disque plein : page annulée, reprise.
 */

const TASK_COLUMNS = syncTable('task')?.columns.length ?? 0;
const COUNT = 501;

let devices: SimDevice[] = [];
const room: Room = { devices: [] };
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  setEpochSwitchTestHooks({});
  clearEpochCarryNoticeFailure();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
  await closeAll(room);
  room.devices.length = 0;
});

const reportsOf = async (d: SimDevice): Promise<EpochCarryReport[]> => (await d.data.repos.carryReports()).list(20);
/** Compte rendu sans ce qui dépend de l'instant de l'exécution. */
const stable = (r: EpochCarryReport | undefined) => r && { ...r, id: 0, createdAt: null };

/** P lu par A puis remplacé ; `count` tâches de B sous P jamais lues par A ; rend A et B juste avant le cycle de B qui change d'époque. */
async function replacedParent(count: number): Promise<[SimDevice, SimDevice]> {
  const [a, b] = await twoDevices();
  devices = [a, b];
  const copy = await backupOf(a);
  a.clock.advance(60_000);
  await a.data.repos.projects.create(projectP);
  await readByBoth(a, b);
  await b.data.repos.tasks.createMany(tasksUnder(P_ID, count));
  await b.cycle();
  await applyEverywhere(a, copy);
  syncFolders(devices);
  return [a, b];
}

describe('Y-TECH-05 : constitution et persistance du compte rendu', () => {
  it('critère 9 : tâche d’un projet remplacé : recréée et dans la troisième liste (rattachée, cause parent-replaced), comme la notice', async () => {
    const [a, b] = await replacedParent(1);
    await rounds(devices);
    const [report] = await reportsOf(b);
    const notice = JSON.parse((await b.data.repos.sync.getMeta('epochCarryNotice')) ?? 'null') as { reattached: unknown[] };
    const t = tasksUnder(P_ID, 1)[0];
    expect(stable(report)).toEqual({
      id: 0,
      createdAt: null,
      epoch: JSON.parse((await a.data.repos.sync.getMeta('epoch')) ?? 'null') as string,
      cause: 'restore',
      reporter: B_ID,
      opener: A_ID,
      mode: 'replace',
      authors: [{ device: B_ID, fields: TASK_COLUMNS, rows: 1, tombs: 0, late: 0 }],
      restored: [],
      recreated: [{ table: 'task', rowId: t?.id, label: 'Tâche 0', by: B_ID, deletedAt: null, deletedBy: null }],
      parentReplaced: notice.reattached.map((item) => ({ ...(item as object), kind: 'reattached', cause: 'parent-replaced' })),
      overflow: 0,
      banner: true,
      acknowledgedAt: null,
      damaged: false,
    });
    expect(report?.parentReplaced).toMatchObject([{ table: 'task', rowId: t?.id, column: 'project_id', parentId: P_ID, label: 'Tâche 0' }]);
  });

  it('contrat de la phase 2 : « J’ai vu » acquitte ce seul compte rendu ; la notice perd ses lignes rattachées, carry-reattached disparaît', async () => {
    const [, b] = await replacedParent(1);
    await rounds(devices);
    expect((await b.cycle()).warnings ?? []).toContain('carry-reattached');
    const [report] = await reportsOf(b);
    const at = new Date(b.clock.nowMs()).toISOString() as IsoDateTime;
    expect(await acknowledgeEpochCarryReport(b.data, report?.id ?? -1, at)).toBe(true);
    expect(await acknowledgeEpochCarryReport(b.data, report?.id ?? -1, at)).toBe(false);
    expect((await reportsOf(b))[0]?.acknowledgedAt).toBe(at);
    expect(await b.data.repos.sync.getMeta('epochCarryNotice')).toBeNull();
    expect((await b.cycle()).warnings ?? []).not.toContain('carry-reattached');
  });

  it('critère 9 : une notice antérieure (version sans compte rendu) est copiée une seule fois dans le compte rendu suivant', async () => {
    const [, b] = await replacedParent(1);
    const old = { table: 'task', rowId: '99999999-0000-4000-8000-000000000000', column: 'project_id', parentId: 'p-ancien', space: 'pro', label: 'Ancienne', hlc: `000000000000001-0000-${B_ID}` };
    await b.data.repos.sync.setMeta('epochCarryNotice', JSON.stringify({ v: 1, epoch: 'e0001-x', at: 'x', reattached: [old], held: [], overflow: 0 }));
    await rounds(devices);
    const [report] = await reportsOf(b);
    // Ordre déterministe (table, puis identifiant) : « Tâche 0 » (2000…) avant « Ancienne » (9999…).
    expect(report?.parentReplaced.map((i) => [i.label, i.kind])).toEqual([
      ['Tâche 0', 'reattached'],
      ['Ancienne', 'reattached'],
    ]);
  });

  it('critère 8 : rien à reporter : compte rendu à zéro (lisible dans Détails), sans bandeau', async () => {
    const [a, b] = await twoDevices();
    devices = [a, b];
    const copy = await backupOf(a);
    await applyEverywhere(a, copy);
    await rounds(devices);
    expect((await reportsOf(b)).map(stable)).toEqual([
      { id: 0, createdAt: null, epoch: JSON.parse((await a.data.repos.sync.getMeta('epoch')) ?? 'null') as string, cause: 'restore', reporter: B_ID, opener: A_ID, mode: 'replace', authors: [], restored: [], recreated: [], parentReplaced: [], overflow: 0, banner: false, acknowledgedAt: null, damaged: false },
    ]);
  });

  it('critère 1 : écriture locale faite pendant le changement (epoch-carry-late) : comptée à part, jamais dans les champs ni les lignes', async () => {
    const [a, b] = await twoDevices();
    devices = [a, b];
    const copy = await backupOf(a);
    await applyEverywhere(a, copy);
    syncFolders(devices);
    let late: string | null = null;
    setEpochSwitchTestHooks({
      afterStep: async (step) => {
        if (step === 'a' && late === null) late = (await b.createTask('Écrite pendant le changement')).id;
      },
    });
    await b.cycle();
    expect(b.logger.entries.filter((e) => e.event === 'epoch-carry-late').map((e) => e.detail)).toEqual([{ rows: 1 }]);
    const [report] = await reportsOf(b);
    expect(report?.authors).toEqual([{ device: B_ID, fields: 0, rows: 0, tombs: 0, late: 1 }]);
    expect(report?.recreated).toEqual([{ table: 'task', rowId: late, label: 'Écrite pendant le changement', by: B_ID, deletedAt: null, deletedBy: null }]);
  });

  it('critère 7 : réinitialisation (fusion) : compte rendu avec ses compteurs, listes vides par construction, sans bandeau', async () => {
    const [a, b] = await setupRoom(room, [RESET_B]);
    if (!a || !b) throw new Error('appareils');
    await b.createTask('De B, jamais lue par A');
    await b.cycle();
    expect(await a.service.resetSync()).toMatchObject({ kind: 'started' });
    await reassociate(a, b, room.devices);
    await settle(room.devices, 3);
    const reports = await reportsOf(b);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ cause: 'reset', mode: 'merge', reporter: RESET_B, restored: [], recreated: [], overflow: 0, banner: false });
    expect(reports[0]?.authors.find((x) => x.device === (RESET_B as DeviceId))?.rows ?? 0).toBeGreaterThan(0);
  });

  it('critère 11 : 501 tâches recréées (et rattachées) : 500 lignes nommées, le reste compté, ordre déterministe', async () => {
    const [, b] = await replacedParent(COUNT);
    await rounds(devices);
    const [report] = await reportsOf(b);
    const ids = tasksUnder(P_ID, COUNT).map((t) => t.id);
    // Rétablies d'abord (aucune), puis recréées (501, par identifiant), puis parent remplacé (501) : 500 gardées, 502 comptées.
    expect(report?.recreated.map((i) => i.rowId)).toEqual(ids.slice(0, 500));
    expect(report?.parentReplaced).toEqual([]);
    expect(report?.overflow).toBe(COUNT * 2 - 500);
    expect(report?.authors).toEqual([{ device: B_ID, fields: TASK_COLUMNS * COUNT, rows: COUNT, tombs: 0, late: 0 }]);
  });
});

/** Rangs (écritures comptées par `armCrash`) des transactions de B pendant l'étape (c), et de la première après elle. */
function recordPageBoundaries(b: SimDevice, probe: CrashProbe): number[] {
  let step: SwitchStep | null = null;
  setEpochSwitchTestHooks({
    afterStep: (done) => {
      step = done === 'b' ? 'c' : done === 'c' ? 'd' : step;
    },
  });
  const boundaries: number[] = [];
  let afterC = false;
  const driver = b.driver as unknown as { transaction: (fn: unknown) => Promise<unknown> };
  const inner = driver.transaction.bind(b.driver);
  driver.transaction = (fn) => {
    const running = inner(fn);
    if (step === 'c') boundaries.push(probe.writes);
    else if (step === 'd' && !afterC) {
      afterC = true;
      boundaries.push(probe.writes);
    }
    return running;
  };
  return boundaries;
}

let reference: unknown = null;
let boundaries: number[] = [];

describe('Y-TECH-05 : reprise après arrêt brutal (critère 6)', () => {
  it('exécution de référence sans arrêt : deux pages de reapply', async () => {
    const [, b] = await replacedParent(COUNT);
    const probe = armCrash(b, null);
    boundaries = recordPageBoundaries(b, probe);
    await b.cycle();
    probe.disarm();
    await rounds(devices);
    expect(boundaries).toHaveLength(3);
    const reports = await reportsOf(b);
    expect(reports).toHaveLength(1);
    reference = stable(reports[0]);
    expect(reference).toMatchObject({ overflow: COUNT * 2 - 500, banner: true });
  });

  it.each([
    ['avant la première page', 0],
    ['entre les deux pages', 1],
    ['après la dernière page', 2],
  ])('arrêt brutal %s de reapply : un seul compte rendu, identique à l’exécution sans arrêt', async (_label, index) => {
    expect(reference).not.toBeNull();
    const [, b] = await replacedParent(COUNT);
    const probe = armCrash(b, boundaries[index] as number);
    await b.cycle().catch(() => undefined);
    expect(probe.crashed).toBe(true);
    probe.disarm();
    await b.restart();
    await rounds(devices);
    expect((await reportsOf(b)).map(stable)).toEqual([reference]);
  });
});

describe('Y-TECH-05 : échec d’écriture du compte rendu (critère 14)', () => {
  /** Toute écriture dans `epoch_carry_report` sur B échoue par `refuse()` tant que `armed` est vrai. */
  function failReportWrites(b: SimDevice, refuse: () => Error): () => void {
    let armed = true;
    type Exec = { execute: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
    const failing = (target: Exec): Exec => {
      const execute = target.execute.bind(target);
      return new Proxy(target, {
        get: (obj, key) => (key === 'execute' ? (sql: string, params?: readonly unknown[]) => (armed && /epoch_carry_report/i.test(sql) ? Promise.reject(refuse()) : execute(sql, params)) : (Reflect.get(obj, key) as unknown)),
      });
    };
    const driver = b.driver as unknown as Exec & { transaction: (fn: (tx: Exec) => Promise<unknown>) => Promise<unknown> };
    const transaction = driver.transaction.bind(b.driver);
    driver.transaction = (fn) => transaction((tx) => fn(failing(tx)));
    return () => (armed = false);
  }

  /** Bases de référence : même scénario sans panne. */
  async function referenceTasks(): Promise<unknown[]> {
    const [a, b] = await replacedParent(1);
    await rounds(devices);
    const tasks = await rowsOf(a, 'task');
    expect(await rowsOf(b, 'task')).toEqual(tasks);
    await Promise.all(devices.map((d) => d.close()));
    devices = [];
    return tasks.map((row) => ({ ...(row as object), hlc: null }));
  }

  it('autre cause que le stockage : données reportées comme sans panne ; échec journalisé, marqué et visible ; aucun compte rendu', async () => {
    const expectedTasks = await referenceTasks();
    const [a, b] = await replacedParent(1);
    failReportWrites(b, () => Object.assign(new Error('compte rendu refusé'), { name: 'ReportRefused' }));
    await rounds(devices);
    expect((await rowsOf(a, 'task')).map((row) => ({ ...(row as object), hlc: null }))).toEqual(expectedTasks);
    expect(await rowsOf(b, 'task')).toEqual(await rowsOf(a, 'task'));
    expect(await b.data.repos.sync.parkedCount(['epoch-carry'])).toBe(0);
    expect(b.logger.entries.filter((e) => e.event === EPOCH_CARRY_REPORT_FAILED_EVENT).map((e) => e.detail)).toEqual([{ code: 'ReportRefused' }]);
    expect(JSON.parse((await b.data.repos.sync.getMeta(EPOCH_CARRY_REPORT_FAILED_META)) ?? 'null')).toMatchObject({ code: 'ReportRefused', epoch: expect.stringMatching(/^e0002-/) as string });
    expect((await b.cycle()).warnings ?? []).toContain('carry-reattached');
    expect(await b.driver.select('SELECT id FROM epoch_carry_report')).toEqual([]);
  });

  it.each([
    ['SQLITE_FULL', 'SQLITE_FULL: database or disk is full'],
    ['SQLITE_IOERR', 'SQLITE_IOERR: disk I/O error'],
  ])('%s : la page est annulée entière (reports gardés), reprise au cycle suivant, compte rendu complet, rien de perdu', async (_code, message) => {
    const [, b] = await replacedParent(1);
    const disarm = failReportWrites(b, () => new DbError('unknown', message, { cause: new Error(message) }));
    await b.cycle();
    expect(await b.data.repos.sync.parkedCount(['epoch-carry'])).toBeGreaterThan(0);
    expect(b.logger.entries.filter((e) => e.event === EPOCH_CARRY_REPORT_FAILED_EVENT)).toEqual([]);
    disarm();
    await rounds(devices);
    expect(await b.data.repos.sync.parkedCount(['epoch-carry'])).toBe(0);
    const [report] = await reportsOf(b);
    expect(report?.recreated.map((i) => i.label)).toEqual(['Tâche 0']);
    expect(report?.authors).toEqual([{ device: B_ID, fields: TASK_COLUMNS, rows: 1, tombs: 0, late: 0 }]);
  });
});
