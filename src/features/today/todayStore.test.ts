import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { resolveTodayTasks, todayStore } from './todayStore';

const DEVICE = asEntityId<DeviceId>('50000000-0000-4000-8000-000000000001');
const DAY = asLocalDate('2026-10-02');

describe('todayStore (T-01)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
  });

  afterEach(() => db.close());

  // Tâches affichées : ids du store + entités de la source unique, triées (T-02, T-04).
  const shown = (store: { getState(): { taskIds: readonly TaskId[] } }) =>
    resolveTodayTasks(store.getState().taskIds, container.taskEntities.getSnapshot());

  it('charge une liste vide puis ajoute une tâche visible aussitôt (critères 1, 3, 11, 16)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    expect(shown(store)).toEqual([]);

    const result = await store.getState().addTask('Appeler le notaire', SPACE_PRO_ID);
    expect(result.ok).toBe(true);
    expect(shown(store).map((task) => task.title)).toEqual(['Appeler le notaire']);

    const persisted = await container.data.repos.tasks.listForDay(DAY, 'all');
    expect(persisted).toHaveLength(1);
  });

  it('ne modifie pas la liste pour un titre vide (critère 2)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    const result = await store.getState().addTask('   ', SPACE_PRO_ID);
    expect(result.ok).toBe(false);
    expect(shown(store)).toEqual([]);
  });

  it('une tâche créée hors du filtre actif n’apparaît pas dans la liste rechargée (critère 10)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, SPACE_PRO_ID);
    const result = await store.getState().addTask('Envoyer la facture', SPACE_PERSO_ID);
    expect(result.ok).toBe(true);
    expect(shown(store)).toEqual([]);
  });

  it('load() n’échoue jamais : publie un statut d’erreur si la lecture échoue', async () => {
    const store = todayStore.get(container);
    vi.spyOn(container.data.repos.tasks, 'listForDay').mockRejectedValueOnce(new Error('boom'));

    await expect(store.getState().load(DAY, 'all')).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ status: 'error', errorKey: 'tasks.todayError' });
  });

  it('load() ignore un résultat périmé quand un appel plus récent a démarré entre-temps', async () => {
    const store = todayStore.get(container);
    const spy = vi.spyOn(container.data.repos.tasks, 'listForDay');
    let resolveFirst: ((tasks: never[]) => void) | undefined;
    spy.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve as never)));

    const first = store.getState().load(DAY, 'all');
    await store.getState().load(DAY, SPACE_PRO_ID); // appel plus récent, résout normalement
    expect(store.getState().filter).toBe(SPACE_PRO_ID);

    resolveFirst?.([]);
    await first;
    // Le résultat périmé du premier appel ne doit pas écraser le filtre du second.
    expect(store.getState().filter).toBe(SPACE_PRO_ID);
  });

  it('addTask() n’échoue jamais : publie un statut d’erreur si la création échoue', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    vi.spyOn(container.data.repos.tasks, 'create').mockRejectedValueOnce(new Error('boom'));

    const result = await store.getState().addTask('Appeler le notaire', SPACE_PRO_ID);
    expect(result).toEqual({ ok: false, error: 'unexpected' });
    expect(store.getState()).toMatchObject({ status: 'error', errorKey: 'tasks.todayError' });
  });

  it('trie les tâches de la liste chargée : à l’heure d’abord, puis sans heure (critères 3, 4, T-02, Q11)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    // `sort_order` (A-02) vaut l'horodatage de création : avancer l'horloge entre
    // deux créations garantit un ordre manuel déterministe pour C et D, comme en
    // conditions réelles (saisies séparées dans le temps).
    await store.getState().addTask('A (14:00)', SPACE_PRO_ID, { time: asLocalTime('14:00') });
    db.clock.advance(1);
    await store.getState().addTask('B (09:00)', SPACE_PRO_ID, { time: asLocalTime('09:00') });
    db.clock.advance(1);
    await store.getState().addTask('C sans heure', SPACE_PRO_ID);
    db.clock.advance(1);
    await store.getState().addTask('D sans heure', SPACE_PRO_ID);

    expect(shown(store).map((task) => task.title)).toEqual([
      'B (09:00)',
      'A (14:00)',
      'C sans heure',
      'D sans heure',
    ]);
  });

  it('une tâche datée sur un autre jour que celui affiché n’apparaît pas dans la liste rechargée (critère 1)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    const thursday = asLocalDate('2026-10-08');
    const result = await store.getState().addTask('Jeudi prochain', SPACE_PRO_ID, { date: thursday });

    expect(result.ok).toBe(true);
    expect(shown(store)).toEqual([]); // toujours la liste du jour affiché (DAY), pas celle de jeudi
    expect(store.getState().date).toBe(DAY);
    const thursdayTasks = await container.data.repos.tasks.listForDay(thursday, 'all');
    expect(thursdayTasks.map((task) => task.title)).toEqual(['Jeudi prochain']);
  });

  it('lit les tâches dans la source unique : une écriture ailleurs (fiche détail) est reflétée sans copie (ADR 0004 avenant)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Envoyer la facture', SPACE_PRO_ID);
    const [task] = shown(store);
    if (!task) throw new Error('fixture manquante');

    const updated = await createTaskUseCases(container).update(task.id, { note: 'À relire' });

    expect(updated.note).toBe('À relire');
    expect(shown(store)).toMatchObject([{ note: 'À relire' }]);
  });

  it('toggleDone termine une tâche et la descend sous les tâches à faire (T-04, critères 1, 2)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Boire de l’eau', SPACE_PRO_ID);
    await store.getState().addTask('Faire mon lit', SPACE_PRO_ID);
    const [first] = shown(store);
    if (!first) throw new Error('fixture manquante');

    await store.getState().toggleDone(first.id);

    const titles = shown(store).map((task) => task.title);
    expect(titles.at(-1)).toBe(first.title); // terminée : descendue en bas
    expect(shown(store).find((task) => task.id === first.id)).toMatchObject({ status: 'done' });
    expect(shown(store).find((task) => task.id === first.id)?.doneAt).not.toBeNull();
  });

  it('toggleDone rouvre une tâche terminée, doneAt redevient null (T-04, critère 5)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Boire de l’eau', SPACE_PRO_ID);
    const [task] = shown(store);
    if (!task) throw new Error('fixture manquante');

    await store.getState().toggleDone(task.id);
    await store.getState().toggleDone(task.id);

    expect(shown(store).find((t) => t.id === task.id)).toMatchObject({ status: 'todo', doneAt: null });
  });

  it('toggleDone ignore un id absent de la liste affichée', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await expect(store.getState().toggleDone(asEntityId<TaskId>('99999999-0000-4000-8000-000000000099'))).resolves.toBeUndefined();
    expect(store.getState().status).toBe('ready');
  });

  it('toggleDone n’échoue jamais : publie un statut d’erreur si l’écriture échoue', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Boire de l’eau', SPACE_PRO_ID);
    const [task] = shown(store);
    if (!task) throw new Error('fixture manquante');
    vi.spyOn(container.data.repos.tasks, 'complete').mockRejectedValueOnce(new Error('boom'));

    await expect(store.getState().toggleDone(task.id)).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ status: 'ready', actionErrorKey: 'tasks.completeError' });
    expect(shown(store)).toHaveLength(1); // la liste reste affichée
  });

  it('postpone retire la tâche de la liste du jour (revérification date et espace) et l’annulation la remet (T-05)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Courses', SPACE_PRO_ID);
    const view = () => resolveTodayTasks(store.getState().taskIds, container.taskEntities.getSnapshot(), { date: DAY, filter: 'all' });
    const [task] = view();
    if (!task) throw new Error('fixture manquante');

    await store.getState().postpone(task.id, 'tomorrow');
    expect(view()).toEqual([]);
    expect(store.getState().actionErrorKey).toBeNull();

    await container.undo.undoLast();
    expect(view().map((t) => t.title)).toEqual(['Courses']);
  });

  it('resolveTodayTasks écarte une tâche d’un autre espace que le filtre', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Courses', SPACE_PERSO_ID);
    const ids = store.getState().taskIds;
    const entities = container.taskEntities.getSnapshot();
    expect(resolveTodayTasks(ids, entities, { date: DAY, filter: SPACE_PRO_ID })).toEqual([]);
    expect(resolveTodayTasks(ids, entities, { date: DAY, filter: SPACE_PERSO_ID })).toHaveLength(1);
  });

  it('postpone n’échoue jamais : erreur d’écriture -> actionErrorKey (T-05)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    await store.getState().addTask('Courses', SPACE_PRO_ID);
    const [task] = shown(store);
    if (!task) throw new Error('fixture manquante');
    vi.spyOn(container.data, 'transaction').mockRejectedValueOnce(new Error('boom'));

    await expect(store.getState().postpone(task.id, 'tomorrow')).resolves.toBeUndefined();
    expect(store.getState().actionErrorKey).toBe('tasks.postponeError');
    expect(shown(store)).toHaveLength(1);
  });

  it('isole les instances par conteneur (ADR 0004)', async () => {
    const other = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    expect(todayStore.get(container)).toBe(todayStore.get(container));
    expect(todayStore.get(container)).not.toBe(todayStore.get(other));
  });
});
