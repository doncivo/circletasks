import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createUndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import type { TaskUseCaseDeps, TaskUseCases } from './taskUseCases';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000001');

/**
 * Intégration avec de vrais repositories (SQLite Wasm) : `createTaskUseCases.create`
 * est le seul cas d'usage livré par T-01 (les autres lèvent `NotImplementedError`,
 * couverts ailleurs quand leur story arrive).
 */
describe('createTaskUseCases.create (T-01)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    const deps: TaskUseCaseDeps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack() };
    useCases = createTaskUseCases(deps);
  });

  afterEach(() => db.close());

  it('crée une tâche avec les valeurs par défaut et la persiste (critères 9, 11)', async () => {
    const result = await useCases.create({ title: '  Appeler le notaire  ', spaceId: SPACE_PRO_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const task = result.value;
    expect(task.title).toBe('Appeler le notaire'); // critère 12 : espaces retirés
    expect(task.date).toBe(todayLocal(db.clock));
    expect(task.time).toBeNull();
    expect(task.note).toBe('');
    expect(task.icon).toBeNull();
    expect(task.recurrenceId).toBeNull();
    expect(task.goalId).toBeNull();
    expect(task.projectId).toBeNull();
    expect(task.someday).toBe(false);
    expect(task.status).toBe('todo');
    expect(task.doneAt).toBeNull();
    expect(task.spaceId).toBe(SPACE_PRO_ID);

    const persisted = await db.data.repos.tasks.getById(task.id);
    expect(persisted).toEqual(task);
  });

  it('refuse un titre vide ou composé uniquement d’espaces, sans écrire en base', async () => {
    const result = await useCases.create({ title: '   ', spaceId: SPACE_PRO_ID });
    expect(result).toEqual({ ok: false, error: 'empty-title' });
    expect(await db.data.repos.tasks.listForDay(todayLocal(db.clock), 'all')).toEqual([]);
  });

  it('accepte 200 caractères, refuse au-delà avec un code d’erreur distinct (critère 13)', async () => {
    const ok = await useCases.create({ title: 'a'.repeat(200), spaceId: SPACE_PRO_ID });
    expect(ok.ok).toBe(true);
    const tooLong = await useCases.create({ title: 'a'.repeat(201), spaceId: SPACE_PRO_ID });
    expect(tooLong).toEqual({ ok: false, error: 'title-too-long' });
  });

  it('conserve accents, emoji et caractères spéciaux (critère 14)', async () => {
    const title = 'Café ☕ & “test”';
    const result = await useCases.create({ title, spaceId: SPACE_PRO_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe(title);
  });

  it('crée deux tâches distinctes pour un titre identique (critère 15, pas de dédoublonnage)', async () => {
    const first = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    const second = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.id).not.toBe(second.value.id);
    expect(await db.data.repos.tasks.listForDay(todayLocal(db.clock), 'all')).toHaveLength(2);
  });

  it('respecte l’espace fourni par l’appelant (critère 10 : résolu en amont par resolveDefaultSpaceId)', async () => {
    const result = await useCases.create({ title: 'Envoyer la facture', spaceId: SPACE_PERSO_ID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.spaceId).toBe(SPACE_PERSO_ID);
  });

  it('lève NotImplementedError pour les autres cas d’usage, non livrés par T-01', async () => {
    await expect(
      useCases.complete(asEntityId<TaskId>('00000000-0000-4000-8000-000000000099')),
    ).rejects.toThrow(/à implémenter/);
  });
});
