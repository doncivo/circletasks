import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { donePeriodOf } from '../../domain/donePeriod';
import { asEntityId, asLocalDate, type DeviceId, type TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createAppContainer, type AppContainer } from '../app/container';
import { undoMessage } from '../app/undo';
import { createDoneTasksUseCases } from './doneTasksUseCases';
import { doneTasksStore, resolveDoneTasks } from './doneTasksStore';
import { createTaskUseCases } from './createTaskUseCases';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a7');
const TODAY = asLocalDate('2026-09-23');
/** Heure locale de l'appareil -> instant UTC. */
const at = (local: string) => new Date(local).getTime();

describe('tâches terminées : cas d’usage et store (T-07)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, at('2026-09-23T09:00:00'));
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
  });
  afterEach(() => db.close());

  /** Crée puis termine une tâche à l'heure locale donnée. */
  async function doneAt(title: string, local: string, spaceId = SPACE_PRO_ID): Promise<TaskId> {
    const useCases = createTaskUseCases(container);
    const created = await useCases.create({ title, spaceId, date: TODAY });
    if (!created.ok) throw new Error('création impossible');
    db.clock.set(at(local));
    await useCases.complete(created.value.id);
    return created.value.id;
  }

  const store = () => doneTasksStore.get(container);

  it('ouvre sur le jour courant, filtre d’espace appliqué, publie dans taskEntities (critères 1, 5)', async () => {
    const pro = await doneAt('Pro', '2026-09-23T18:04:00');
    await doneAt('Perso', '2026-09-23T19:00:00', SPACE_PERSO_ID);
    await store().getState().open(TODAY, SPACE_PRO_ID);
    const state = store().getState();
    expect(state.period).toEqual(donePeriodOf('day', TODAY));
    expect(state.status).toBe('ready');
    expect(state.taskIds).toEqual([pro]);
    expect(container.taskEntities.get(pro)?.title).toBe('Pro');

    await state.setFilter('all');
    expect(store().getState().taskIds).toHaveLength(2);
  });

  it('Jour / Semaine / Mois et précédent / suivant (critères 2, 3)', async () => {
    const monday = await doneAt('Lundi', '2026-09-21T10:00:00');
    const today = await doneAt('Aujourd’hui', '2026-09-23T10:00:00');
    const earlier = await doneAt('Début de mois', '2026-09-02T10:00:00');
    await store().getState().open(TODAY, 'all');
    expect(store().getState().taskIds).toEqual([today]);

    await store().getState().selectKind('week');
    expect(store().getState().period).toMatchObject({ kind: 'week', from: '2026-09-21', to: '2026-09-27' });
    expect(new Set(store().getState().taskIds)).toEqual(new Set([monday, today]));

    await store().getState().selectKind('month');
    expect(new Set(store().getState().taskIds)).toEqual(new Set([monday, today, earlier]));

    await store().getState().shift(1);
    expect(store().getState()).toMatchObject({ taskIds: [], status: 'ready', period: { from: '2026-10-01' } });
    await store().getState().shift(-1);
    await store().getState().shift(-1);
    expect(store().getState().period).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });

    await store().getState().selectKind('day');
    await store().getState().shift(-1);
    expect(store().getState().period).toMatchObject({ kind: 'day', from: '2026-07-31' });
  });

  it('rouvrir : la tâche quitte la liste, annulable (message, nouvelle complétion à l’heure d’origine) (critère 6)', async () => {
    const id = await doneAt('À rouvrir', '2026-09-23T18:04:00');
    const originalDoneAt = (await db.data.repos.tasks.getById(id))?.doneAt;
    await store().getState().open(TODAY, 'all');
    const view = () => resolveDoneTasks(store().getState().taskIds, container.taskEntities.getSnapshot(), store().getState());
    expect(view()).toHaveLength(1);

    db.clock.advance(60_000);
    await store().getState().reopen(id);
    expect(view()).toEqual([]);
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ status: 'todo', doneAt: null });
    const top = container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« À rouvrir » rouverte');

    expect((await container.undo.undoLast()).status).toBe('undone');
    expect(view().map((t) => t.id)).toEqual([id]);
    expect((await db.data.repos.tasks.getById(id))?.doneAt).toBe(originalDoneAt);
  });

  it('annulation périmée si la tâche a changé entre-temps : rien n’est écrit', async () => {
    const id = await doneAt('Modifiée', '2026-09-23T18:04:00');
    const useCases = createDoneTasksUseCases(container);
    await useCases.reopen(id);
    await createTaskUseCases(container).update(id, { note: 'changée ailleurs' });
    expect((await container.undo.undoLast()).status).toBe('stale');
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ status: 'todo' });
  });

  it('rouvrir une tâche absente de la liste ne fait rien ; une erreur d’écriture est gérée sans rejet', async () => {
    const id = await doneAt('Tâche', '2026-09-23T18:04:00');
    await store().getState().open(TODAY, 'all');
    await store().getState().reopen(asEntityId<TaskId>('70000000-0000-4000-8000-00000000dead'));
    expect(store().getState().actionErrorKey).toBeNull();

    await db.data.repos.tasks.softDelete([id]); // la ligne n'existe plus pour reopen : not-found
    await expect(store().getState().reopen(id)).resolves.toBeUndefined();
    expect(store().getState().actionErrorKey).toBe('done.reopenError');
  });

  it('une tâche supprimée (corbeille) n’apparaît pas ; erreur de lecture : état d’erreur sans rejet (critère 9)', async () => {
    const id = await doneAt('Supprimée', '2026-09-23T18:04:00');
    await db.data.repos.tasks.softDelete([id]);
    await store().getState().open(TODAY, 'all');
    expect(store().getState().taskIds).toEqual([]);

    await db.close();
    await expect(store().getState().open(TODAY, 'all')).resolves.toBeUndefined();
    expect(store().getState()).toMatchObject({ status: 'error', errorKey: 'done.loadError' });
    db = await openTestDb(DEVICE); // rouvert pour l'afterEach
  });

  it('resolveDoneTasks revérifie période et espace dans la source unique', async () => {
    const id = await doneAt('Pro', '2026-09-23T18:04:00');
    await store().getState().open(TODAY, 'all');
    const entities = container.taskEntities.getSnapshot();
    const ids = store().getState().taskIds;
    expect(resolveDoneTasks(ids, entities, { period: donePeriodOf('day', TODAY), filter: SPACE_PERSO_ID })).toEqual([]);
    expect(resolveDoneTasks(ids, entities, { period: donePeriodOf('day', asLocalDate('2026-09-24')), filter: 'all' })).toEqual([]);
    expect(resolveDoneTasks(ids, entities, { period: null, filter: 'all' })).toEqual([]);
    expect(resolveDoneTasks(ids, entities, { period: donePeriodOf('day', TODAY), filter: SPACE_PRO_ID }).map((t) => t.id)).toEqual([id]);
  });
});
