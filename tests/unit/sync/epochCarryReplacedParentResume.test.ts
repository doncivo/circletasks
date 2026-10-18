import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/db/driver';
import { clearEpochCarryNoticeFailure } from '../../../src/sync/carryNoticeState';
import { setEpochSwitchTestHooks, type SwitchStep } from '../../../src/sync/epochSwitch';
import { armCrash, type CrashProbe } from '../../sim/syncCrash';
import { syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { P_ID, applyEverywhere, backupOf, projectP, readByBoth, rounds, rowsOf, tasksUnder, twoDevices } from './epochCarryKit';

/**
 * Y-FIX-04 (B4) : reprise et convergence du report d'un enfant dont le parent a été remplacé.
 * Critère 9 : arrêt brutal (`armCrash`) à chaque borne de page de `reapply` (avant la première page, entre les deux pages, après la dernière) :
 * résultat identique à une exécution sans arrêt, notice sans doublon, aucune ligne perdue ni rattachée deux fois.
 * Critère 10 : second changement d'époque : aucun doublon, le parent remplacé ne revient pas.
 * Critère 14 : écriture de la notice refusée : données reportées comme sans panne, avertissement visible, journal ; disque plein ou erreur
 * d'entrée-sortie (revue I5) : page annulée entière, reprise au cycle suivant, rien de perdu.
 */

/** 501 tâches de B sous P : deux pages de `reapply` (500 + 1). */
const COUNT = 501;

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  setEpochSwitchTestHooks({});
  clearEpochCarryNoticeFailure();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** Scénario du critère 1 à 501 tâches ; rend A et B juste avant le cycle de B qui change d'époque. */
async function scenario(): Promise<[SimDevice, SimDevice]> {
  const [a, b] = await twoDevices();
  devices = [a, b];
  const copy = await backupOf(a);
  a.clock.advance(60_000);
  await a.data.repos.projects.create(projectP);
  await readByBoth(a, b);
  await b.data.repos.tasks.createMany(tasksUnder(P_ID, COUNT));
  await b.cycle();
  await applyEverywhere(a, copy);
  syncFolders(devices);
  return [a, b];
}

interface Notice {
  readonly reattached: readonly { readonly table: string; readonly rowId: string; readonly column: string; readonly parentId: string; readonly space: string | null; readonly label: string | null; readonly hlc: string }[];
  readonly held: readonly unknown[];
  readonly overflow: number;
}
const noticeOf = async (d: SimDevice): Promise<Notice | null> => JSON.parse((await d.data.repos.sync.getMeta('epochCarryNotice')) ?? 'null') as Notice | null;

/** État final comparé : tâches des deux appareils, projets, notice de B (sans l'heure). */
async function outcome(a: SimDevice, b: SimDevice): Promise<unknown> {
  const notice = await noticeOf(b);
  const tasks = (await b.driver.select<{ project_id: string | null; deleted_at: string | null }>('SELECT project_id, deleted_at FROM task'));
  return {
    sameTasks: JSON.stringify(await rowsOf(a, 'task')) === JSON.stringify(await rowsOf(b, 'task')),
    tasks: tasks.length,
    attached: tasks.filter((t) => t.project_id !== null).length,
    deleted: tasks.filter((t) => t.deleted_at !== null).length,
    projects: [(await rowsOf(a, 'project')).length, (await rowsOf(b, 'project')).length],
    notice: notice && { items: notice.reattached.map((i) => [i.rowId, i.column, i.parentId, i.label]), unique: new Set(notice.reattached.map((i) => i.rowId)).size, held: notice.held.length, overflow: notice.overflow },
    parked: (await b.driver.select<{ n: number }>("SELECT COUNT(*) AS n FROM sync_parked WHERE reason = 'epoch-carry'"))[0]?.n,
  };
}

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

describe('Y-FIX-04 : reprise et convergence (critères 9, 10, 14)', () => {
  it('exécution de référence sans arrêt : 501 tâches rattachées, deux pages, notice bornée sans doublon', async () => {
    const [a, b] = await scenario();
    const probe = armCrash(b, null);
    boundaries = recordPageBoundaries(b, probe);
    await b.cycle();
    probe.disarm();
    await rounds(devices);
    // Deux pages de `reapply` : deux transactions dans l'étape (c), puis la première de l'étape (d).
    expect(boundaries).toHaveLength(3);
    reference = await outcome(a, b);
    expect(reference).toMatchObject({ sameTasks: true, tasks: COUNT, attached: 0, deleted: 0, projects: [0, 0], notice: { unique: 200, held: 0, overflow: COUNT - 200 }, parked: 0 });
  });

  it.each([
    ['avant la première page', 0],
    ['entre les deux pages', 1],
    ['après la dernière page', 2],
  ])('critère 9 : arrêt brutal %s de `reapply` : même résultat que sans arrêt', async (_label, index) => {
    expect(reference).not.toBeNull();
    const [a, b] = await scenario();
    const crashAt = boundaries[index] as number;
    const probe = armCrash(b, crashAt);
    await b.cycle().catch(() => undefined);
    expect(probe.crashed).toBe(true);
    probe.disarm();
    await b.restart();
    await rounds(devices);
    expect(await outcome(a, b)).toEqual(reference);
  });

  it('critère 10 : second changement d’époque (B restaure « Appliquer partout ») : aucun doublon, P ne revient pas', async () => {
    const [a, b] = await twoDevices();
    devices = [a, b];
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await a.data.repos.projects.create(projectP);
    await readByBoth(a, b);
    const [t] = await b.data.repos.tasks.createMany(tasksUnder(P_ID, 1));
    await b.cycle();
    await applyEverywhere(a, copy);
    await rounds(devices);
    const first = await noticeOf(b);
    expect(first?.reattached.map((i) => i.rowId)).toEqual([t?.id]);
    // Second report : B ouvre l'époque suivante avec sa propre sauvegarde (T « Sans projet ») ; A reporte ce que B n'avait pas lu.
    const copyB = await backupOf(b);
    b.clock.advance(60_000);
    await applyEverywhere(b, copyB);
    await rounds(devices);
    for (const d of [a, b]) {
      const rows = await d.driver.select<{ id: string; project_id: string | null; deleted_at: string | null }>('SELECT id, project_id, deleted_at FROM task');
      expect(rows, d.name).toEqual([{ id: t?.id, project_id: null, deleted_at: null }]);
      expect(await d.data.repos.projects.getById(P_ID, { includeDeleted: true }), d.name).toBeNull();
    }
    expect(await rowsOf(a, 'task')).toEqual(await rowsOf(b, 'task'));
    // La notice de B n'a pas d'item en double ; A n'en a pas (rien n'y a été rattaché).
    expect((await noticeOf(b))?.reattached.map((i) => i.rowId)).toEqual([t?.id]);
    expect(await noticeOf(a)).toBeNull();
  });

  /** Scénario du critère 1 (une tâche) ; toute écriture de la clé `epochCarryNotice` sur B échoue par `refuse()` tant que `armed` est vrai. */
  async function noticeFailureScenario(refuse: () => Error): Promise<{ a: SimDevice; b: SimDevice; t: string; disarm: () => void }> {
    const [a, b] = await twoDevices();
    devices = [a, b];
    const copy = await backupOf(a);
    a.clock.advance(60_000);
    await a.data.repos.projects.create(projectP);
    await readByBoth(a, b);
    const [t] = await b.data.repos.tasks.createMany(tasksUnder(P_ID, 1));
    await b.cycle();
    await applyEverywhere(a, copy);
    let armed = true;
    type Exec = { execute: (sql: string, params?: readonly unknown[]) => Promise<unknown> };
    const failing = (target: Exec): Exec => {
      const execute = target.execute.bind(target);
      return new Proxy(target, {
        get: (obj, key) =>
          key === 'execute'
            ? (sql: string, params?: readonly unknown[]) => (armed && /INSERT INTO sync_meta/i.test(sql) && params?.[0] === 'epochCarryNotice' ? Promise.reject(refuse()) : execute(sql, params))
            : (Reflect.get(obj, key) as unknown),
      });
    };
    const driver = b.driver as unknown as Exec & { transaction: (fn: (tx: Exec) => Promise<unknown>) => Promise<unknown> };
    const transaction = driver.transaction.bind(b.driver);
    driver.transaction = (fn) => transaction((tx) => fn(failing(tx)));
    return { a, b, t: String(t?.id), disarm: () => (armed = false) };
  }

  async function expectReattached(a: SimDevice, b: SimDevice, t: string): Promise<void> {
    for (const d of [a, b]) {
      const row = await d.task(t as never);
      expect(row?.deletedAt, d.name).toBeNull();
      expect(row?.projectId, d.name).toBeNull();
    }
    expect(await rowsOf(a, 'task')).toEqual(await rowsOf(b, 'task'));
    expect(await b.data.repos.sync.parkedCount(['epoch-carry'])).toBe(0);
  }

  it('critère 14 : écriture de la notice refusée (autre cause que le stockage) : données reportées comme sans panne, avertissement visible', async () => {
    const { a, b, t } = await noticeFailureScenario(() => Object.assign(new Error('notice refusée'), { name: 'NoticeRefused' }));
    await rounds(devices);
    await expectReattached(a, b, t);
    expect(await noticeOf(b)).toBeNull();
    expect(b.logger.entries.filter((e) => e.event === 'epoch-carry-notice-failed').map((e) => e.detail)).toEqual([{ code: 'NoticeRefused' }]);
    expect(b.logger.entries.filter((e) => e.event === 'epoch-carry-reattached').map((e) => e.detail)).toEqual([{ table: 'task', column: 'project_id', count: 1 }]);
    expect((await b.cycle()).warnings ?? []).toContain('carry-report');
  });

  it.each([
    ['SQLITE_FULL', 'SQLITE_FULL: database or disk is full'],
    ['SQLITE_IOERR', 'SQLITE_IOERR: disk I/O error'],
  ])('critère 14 (revue I5) : %s pendant la notice : la page entière est annulée (reports gardés), reprise au cycle suivant, rien de perdu', async (_code, message) => {
    const { a, b, t, disarm } = await noticeFailureScenario(() => new DbError('unknown', message, { cause: new Error(message) }));
    syncFolders(devices);
    await b.cycle();
    // Rien n'est retiré hors transaction : le report de T est toujours là, aucune notice, aucun journal « notice en échec ».
    expect(await b.data.repos.sync.parkedCount(['epoch-carry'])).toBeGreaterThan(0);
    expect(await noticeOf(b)).toBeNull();
    expect(b.logger.entries.filter((e) => e.event === 'epoch-carry-notice-failed')).toEqual([]);
    disarm();
    await rounds(devices);
    await expectReattached(a, b, t);
    expect((await noticeOf(b))?.reattached.map((i) => i.rowId)).toEqual([t]);
  });
});
