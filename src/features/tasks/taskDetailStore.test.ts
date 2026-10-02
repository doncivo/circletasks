import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { createTaskUseCases } from './createTaskUseCases';
import { taskDetailStore } from './taskDetailStore';

const DEVICE = asEntityId<DeviceId>('70000000-0000-4000-8000-000000000001');

describe('taskDetailStore (T-03)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
  });

  afterEach(() => db.close());

  async function createTask(note = '') {
    const result = await createTaskUseCases(container).create({ title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, note });
    if (!result.ok) throw new Error('setup : création de tâche refusée');
    return result.value;
  }

  it('charge une tâche (critères 3, 5, 7)', async () => {
    const task = await createTask('Relevé de septembre');
    const store = taskDetailStore.get(container);

    await store.getState().load(task.id);

    expect(store.getState()).toMatchObject({ status: 'ready', task: { id: task.id, note: 'Relevé de septembre' } });
  });

  it('enregistre une note multi-lignes, conservée telle quelle (critères 7, 9, 11)', async () => {
    const task = await createTask();
    const store = taskDetailStore.get(container);
    await store.getState().load(task.id);

    await store.getState().updateNote('Ligne 1\nLigne 2');
    expect(store.getState().task?.note).toBe('Ligne 1\nLigne 2');

    const persisted = await container.data.repos.tasks.getById(task.id);
    expect(persisted?.note).toBe('Ligne 1\nLigne 2');

    await store.getState().updateNote('');
    expect(store.getState().task?.note).toBe('');
  });

  it('change puis retire l’icône depuis la fiche (critère 5)', async () => {
    const task = await createTask();
    const store = taskDetailStore.get(container);
    await store.getState().load(task.id);

    await store.getState().updateIcon({ kind: 'lucide', name: 'phone' });
    expect(store.getState().task?.icon).toEqual({ kind: 'lucide', name: 'phone' });

    await store.getState().updateIcon(null);
    expect(store.getState().task?.icon).toBeNull();

    const persisted = await container.data.repos.tasks.getById(task.id);
    expect(persisted?.icon).toBeNull();
  });

  it('persiste note et icône après rechargement (critère 11)', async () => {
    const task = await createTask();
    const store = taskDetailStore.get(container);
    await store.getState().load(task.id);
    await store.getState().updateNote('À relire');
    await store.getState().updateIcon({ kind: 'emoji', value: '📞' });

    const other = taskDetailStore.get(
      createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data }),
    );
    await other.getState().load(task.id);
    expect(other.getState().task).toMatchObject({ note: 'À relire', icon: { kind: 'emoji', value: '📞' } });
  });

  it('publie une erreur sans rejet non géré si le chargement échoue', async () => {
    const store = taskDetailStore.get(container);
    vi.spyOn(container.data.repos.tasks, 'getById').mockRejectedValueOnce(new Error('boom'));

    const task = await createTask();
    await expect(store.getState().load(task.id)).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ status: 'error', errorKey: 'tasks.detailLoadError' });
  });

  it('publie une erreur sans rejet non géré si l’enregistrement échoue', async () => {
    const task = await createTask();
    const store = taskDetailStore.get(container);
    await store.getState().load(task.id);
    vi.spyOn(container.data.repos.tasks, 'update').mockRejectedValueOnce(new Error('boom'));

    await expect(store.getState().updateNote('x')).resolves.toBeUndefined();
    expect(store.getState()).toMatchObject({ status: 'error', errorKey: 'tasks.detailSaveError' });
  });

  it('isole les instances par conteneur (ADR 0004)', () => {
    const other = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    expect(taskDetailStore.get(container)).toBe(taskDetailStore.get(container));
    expect(taskDetailStore.get(container)).not.toBe(taskDetailStore.get(other));
  });
});
