import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { todayStore } from './todayStore';

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

  it('charge une liste vide puis ajoute une tâche visible aussitôt (critères 1, 3, 11, 16)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    expect(store.getState().tasks).toEqual([]);

    const result = await store.getState().addTask('Appeler le notaire', SPACE_PRO_ID);
    expect(result.ok).toBe(true);
    expect(store.getState().tasks.map((task) => task.title)).toEqual(['Appeler le notaire']);

    const persisted = await container.data.repos.tasks.listForDay(DAY, 'all');
    expect(persisted).toHaveLength(1);
  });

  it('ne modifie pas la liste pour un titre vide (critère 2)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, 'all');
    const result = await store.getState().addTask('   ', SPACE_PRO_ID);
    expect(result.ok).toBe(false);
    expect(store.getState().tasks).toEqual([]);
  });

  it('une tâche créée hors du filtre actif n’apparaît pas dans la liste rechargée (critère 10)', async () => {
    const store = todayStore.get(container);
    await store.getState().load(DAY, SPACE_PRO_ID);
    const result = await store.getState().addTask('Envoyer la facture', SPACE_PERSO_ID);
    expect(result.ok).toBe(true);
    expect(store.getState().tasks).toEqual([]);
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

    expect(store.getState().tasks.map((task) => task.title)).toEqual([
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
    expect(store.getState().tasks).toEqual([]); // toujours la liste du jour affiché (DAY), pas celle de jeudi
    expect(store.getState().date).toBe(DAY);
    const thursdayTasks = await container.data.repos.tasks.listForDay(thursday, 'all');
    expect(thursdayTasks.map((task) => task.title)).toEqual(['Jeudi prochain']);
  });

  it('isole les instances par conteneur (ADR 0004)', async () => {
    const other = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    expect(todayStore.get(container)).toBe(todayStore.get(container));
    expect(todayStore.get(container)).not.toBe(todayStore.get(other));
  });
});
