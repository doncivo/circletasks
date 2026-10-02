import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { uuidGenerator } from '../../domain/id';
import { ScheduleInvariantError } from '../../domain/taskSchedule';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type TaskId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
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
    const deps: TaskUseCaseDeps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() };
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
      useCases.postpone([asEntityId<TaskId>('00000000-0000-4000-8000-000000000099')], 'tomorrow'),
    ).rejects.toThrow(/à implémenter/);
  });

  it('refuse une heure sans date (critère T-02 symétrique à T-01)', async () => {
    const result = await useCases.create({ title: 'Sans date', spaceId: SPACE_PRO_ID, date: null, time: asLocalTime('10:00') });
    expect(result).toEqual({ ok: false, error: 'time-without-date' });
  });
});

/**
 * T-02 : `update` applique les invariants de planification (`src/domain/taskSchedule`)
 * avant d'écrire, en plus des autres champs du patch (ici seuls date/heure/someday
 * sont exercés ; les autres champs arrivent avec T-03 / A-08).
 */
describe('createTaskUseCases.update (T-02)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    const deps: TaskUseCaseDeps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() };
    useCases = createTaskUseCases(deps);
  });

  afterEach(() => db.close());

  it('ajoute une heure à une tâche déjà datée (critère 2)', async () => {
    const created = await useCases.create({ title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-10-05') });
    if (!created.ok) throw new Error('fixture invalide');
    const updated = await useCases.update(created.value.id, { time: asLocalTime('14:00') });
    expect(updated.date).toBe(asLocalDate('2026-10-05'));
    expect(updated.time).toBe(asLocalTime('14:00'));
  });

  it('efface l’heure et conserve la date (critère 5, première partie)', async () => {
    const created = await useCases.create({
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-10-05'),
      time: asLocalTime('14:00'),
    });
    if (!created.ok) throw new Error('fixture invalide');
    const updated = await useCases.update(created.value.id, { time: null });
    expect(updated.date).toBe(asLocalDate('2026-10-05'));
    expect(updated.time).toBeNull();
  });

  it('passer en « Un jour » retire aussi la date et l’heure (critère 5, invariant M18)', async () => {
    const created = await useCases.create({
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-10-05'),
      time: asLocalTime('14:00'),
    });
    if (!created.ok) throw new Error('fixture invalide');
    const updated = await useCases.update(created.value.id, { someday: true });
    expect(updated.someday).toBe(true);
    expect(updated.date).toBeNull();
    expect(updated.time).toBeNull();
  });

  it('refuse une heure sans date résultante (invariant)', async () => {
    const created = await useCases.create({ title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-10-05') });
    if (!created.ok) throw new Error('fixture invalide');
    await expect(useCases.update(created.value.id, { date: null, time: asLocalTime('10:00') })).rejects.toBeInstanceOf(
      ScheduleInvariantError,
    );
  });

  it('conserve date et heure après un redémarrage (critère 7, relecture)', async () => {
    const created = await useCases.create({
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-10-05'),
      time: asLocalTime('09:00'),
    });
    if (!created.ok) throw new Error('fixture invalide');
    const reread = await db.data.repos.tasks.getById(created.value.id);
    expect(reread?.date).toBe(asLocalDate('2026-10-05'));
    expect(reread?.time).toBe(asLocalTime('09:00'));
  });
});

/**
 * T-04 : terminer pose status = done et doneAt horodaté, pousse une commande
 * annulable ; rouvrir (décocher) n'est pas annulable (contrat `TaskUseCases`).
 */
describe('createTaskUseCases.complete / reopen (T-04)', () => {
  let db: TestDb;
  let useCases: TaskUseCases;
  let deps: TaskUseCaseDeps;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T08:00:00.000Z');
    deps = { clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() };
    useCases = createTaskUseCases(deps);
  });

  afterEach(() => db.close());

  it('termine une tâche : status, doneAt horodaté, pousse une commande « complete » (critère 1)', async () => {
    const created = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('fixture invalide');

    const done = await useCases.complete(created.value.id);
    expect(done.status).toBe('done');
    expect(done.doneAt).toBe('2026-10-02T08:00:00.000Z');
    expect(deps.undo.getSnapshot()).toMatchObject({ size: 1, top: { kind: 'complete', count: 1, labelParams: { title: 'Boire de l’eau' } } });
    expect(deps.taskEntities.get(done.id)).toEqual(done); // publiée dans la source unique

    const persisted = await db.data.repos.tasks.getById(created.value.id);
    expect(persisted?.status).toBe('done');
  });

  it('terminer une tâche déjà terminée est idempotent : doneAt conservé, rien écrit, rien à annuler', async () => {
    const created = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('fixture invalide');
    const first = await useCases.complete(created.value.id);
    db.clock.advance(60_000);

    const second = await useCases.complete(created.value.id);

    expect(second).toEqual(first);
    expect(deps.undo.getSnapshot().size).toBe(1);
  });

  it('Annuler publie la tâche rouverte dans la source unique', async () => {
    const created = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('fixture invalide');
    await useCases.complete(created.value.id);
    await deps.undo.undoLast();
    expect(deps.taskEntities.get(created.value.id)).toMatchObject({ status: 'todo', doneAt: null });
  });

  it('rouvre une tâche terminée (décocher) sans toucher la pile d’annulation (critère 5)', async () => {
    const created = await useCases.create({ title: 'Faire mon lit', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('fixture invalide');
    await useCases.complete(created.value.id);

    const reopened = await useCases.reopen(created.value.id);
    expect(reopened.status).toBe('todo');
    expect(reopened.doneAt).toBeNull();
    // `reopen` n'est pas annulable : la pile garde seulement la commande de `complete`.
    expect(deps.undo.getSnapshot().size).toBe(1);
  });

  it('Annuler une complétion rouvre la tâche (critère 3)', async () => {
    const created = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('fixture invalide');
    await useCases.complete(created.value.id);

    const result = await deps.undo.undoLast();
    expect(result.status).toBe('undone');
    const reread = await db.data.repos.tasks.getById(created.value.id);
    expect(reread?.status).toBe('todo');
    expect(reread?.doneAt).toBeNull();
  });

  it('une annulation périmée (tâche changée depuis) renvoie « stale » sans rien écrire (ADR 0005)', async () => {
    const created = await useCases.create({ title: 'Boire de l’eau', spaceId: SPACE_PRO_ID });
    if (!created.ok) throw new Error('fixture invalide');
    await useCases.complete(created.value.id);

    // Une autre écriture change le hlc de la ligne avant l'annulation.
    await useCases.update(created.value.id, { title: 'Boire beaucoup d’eau' });

    const result = await deps.undo.undoLast();
    expect(result.status).toBe('stale');
    const reread = await db.data.repos.tasks.getById(created.value.id);
    expect(reread?.status).toBe('done'); // rien écrit par l'annulation périmée
  });
});
