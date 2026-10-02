import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { uuidGenerator } from '../../domain/id';
import { asEntityId, asLocalDate, type DeviceId, type LocalDate, type TaskId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createTaskEntities } from '../app/taskEntities';
import { createUndoStack } from '../app/undo';
import { createTaskUseCases } from './createTaskUseCases';
import { createDayRollover, type Timers } from './dayRollover';

const DEVICE = asEntityId<DeviceId>('40000000-0000-4000-8000-000000000007');

/** Minuterie contrôlée : `fire()` déclenche l'échéance en cours. */
function fakeTimers() {
  let pending: { handler: () => void; ms: number } | null = null;
  const timers: Timers = {
    setTimeout: (handler, ms) => {
      pending = { handler, ms };
      return pending;
    },
    clearTimeout: (handle) => {
      if (pending === handle) pending = null;
    },
  };
  return { timers, pending: () => pending, fire: () => pending?.handler() };
}

// Instants locaux construits sans fuseau : 23 sept. 2026 à 23:30 puis minuit.
const local = (m: number, d: number, h: number, min = 0) => new Date(2026, m, d, h, min).getTime();

describe('createDayRollover (T-06)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, local(8, 23, 23, 30));
  });
  afterEach(() => db.close());

  async function seed(date: string): Promise<TaskId> {
    const useCases = createTaskUseCases({ clock: db.clock, ids: uuidGenerator, data: db.data, undo: createUndoStack(), taskEntities: createTaskEntities() });
    const r = await useCases.create({ title: 'Tâche', spaceId: SPACE_PRO_ID, date: asLocalDate(date) });
    if (!r.ok) throw new Error('création impossible');
    return r.value.id;
  }

  it('au démarrage : report avant la fin de start() puis premier onDayChange (critère 2)', async () => {
    const id = await seed('2026-09-20');
    const days: LocalDate[] = [];
    const ft = fakeTimers();
    const rollover = createDayRollover(
      { clock: db.clock, data: db.data, taskEntities: createTaskEntities() },
      { timers: ft.timers, onDayChange: (d) => days.push(d) },
    );
    await rollover.start();
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-09-23', carriedOver: true });
    expect(days).toEqual(['2026-09-23']);
    rollover.stop();
  });

  it('au passage de minuit : le minuteur vise 00:00 local, reporte au 24 et annonce le jour (critère 1)', async () => {
    const id = await seed('2026-09-23');
    const days: LocalDate[] = [];
    const ft = fakeTimers();
    const rollover = createDayRollover(
      { clock: db.clock, data: db.data, taskEntities: createTaskEntities() },
      { timers: ft.timers, onDayChange: (d) => days.push(d) },
    );
    await rollover.start();
    expect(ft.pending()?.ms).toBe(60_000); // borné à 60 s (veille du PC)
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-09-23', carriedOver: false });

    db.clock.set(local(8, 24, 0, 0));
    ft.fire();
    await rollover.check(); // file d'attente du rollover : attend la fin du contrôle déclenché par la minuterie
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-09-24', carriedOver: true });
    expect(days).toEqual(['2026-09-23', '2026-09-24']);
    // Ré-armé pour le minuit suivant.
    expect(ft.pending()?.ms).toBe(60_000);
    rollover.stop();
    expect(ft.pending()).toBeNull();
  });

  it('veille du PC : l’horloge saute pendant que la minuterie dormait, le prochain tick (≤ 60 s) rattrape le report', async () => {
    const id = await seed('2026-09-23');
    const ft = fakeTimers();
    const days: LocalDate[] = [];
    const rollover = createDayRollover({ clock: db.clock, data: db.data, taskEntities: createTaskEntities() }, { timers: ft.timers, onDayChange: (d) => days.push(d) });
    await rollover.start();
    expect(ft.pending()?.ms).toBeLessThanOrEqual(60_000);
    db.clock.set(local(8, 24, 8, 0)); // sommeil de 8 h : aucun événement visibilitychange ni focus
    ft.fire();
    await rollover.check();
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-09-24', carriedOver: true });
    expect(days).toEqual(['2026-09-23', '2026-09-24']);
    rollover.stop();
  });

  it('plusieurs contrôles le même jour : un seul onDayChange, aucun doublon (critère 9)', async () => {
    await seed('2026-09-22');
    const days: LocalDate[] = [];
    const rollover = createDayRollover(
      { clock: db.clock, data: db.data, taskEntities: createTaskEntities() },
      { timers: fakeTimers().timers, onDayChange: (d) => days.push(d) },
    );
    await Promise.all([rollover.start(), rollover.check(), rollover.check()]);
    expect(days).toEqual(['2026-09-23']);
    rollover.stop();
  });

  it('réglage désactivé : minuit passe sans changer aucune date (critère 5), activé ensuite : pris en compte (critère 8)', async () => {
    await db.data.repos.settings.set('tasks.carryOverUndone', false);
    const id = await seed('2026-09-23');
    const ft = fakeTimers();
    const rollover = createDayRollover({ clock: db.clock, data: db.data, taskEntities: createTaskEntities() }, { timers: ft.timers });
    await rollover.start();
    db.clock.set(local(8, 24, 0, 0));
    ft.fire();
    await rollover.check(); // file d'attente du rollover : attend la fin du contrôle déclenché par la minuterie
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-09-23', carriedOver: false });

    await db.data.repos.settings.set('tasks.carryOverUndone', true);
    db.clock.set(local(8, 25, 0, 0));
    ft.fire();
    await rollover.check(); // file d'attente du rollover : attend la fin du contrôle déclenché par la minuterie
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-09-25', carriedOver: true });
    rollover.stop();
  });

  it('retour de veille après plusieurs jours : un check() rattrape tout, sans doublon ni re-report (critères 2, 9)', async () => {
    const a = await seed('2026-09-20');
    const b = await seed('2026-09-22');
    const ft = fakeTimers();
    const days: LocalDate[] = [];
    const rollover = createDayRollover({ clock: db.clock, data: db.data, taskEntities: createTaskEntities() }, { timers: ft.timers, onDayChange: (d) => days.push(d) });
    await rollover.start();
    db.clock.set(local(8, 27, 8, 0));
    await rollover.check();
    await rollover.check();
    expect(await db.data.repos.tasks.getById(a)).toMatchObject({ date: '2026-09-27', carriedOver: true });
    expect(await db.data.repos.tasks.getById(b)).toMatchObject({ date: '2026-09-27', carriedOver: true });
    expect(days).toEqual(['2026-09-23', '2026-09-27']);
    rollover.stop();
  });

  it('changement d’heure : minuit réarmé depuis l’horloge, un seul report par jour local (critère 9)', async () => {
    const id = await seed('2026-10-24');
    db.clock.set(local(9, 25, 23, 0)); // veille du passage à l'heure d'hiver (25 oct. 2026)
    const ft = fakeTimers();
    const rollover = createDayRollover({ clock: db.clock, data: db.data, taskEntities: createTaskEntities() }, { timers: ft.timers });
    await rollover.start();
    expect(ft.pending()?.ms).toBe(60_000);
    db.clock.set(local(9, 26, 0, 0));
    ft.fire();
    await rollover.check();
    expect(await db.data.repos.tasks.getById(id)).toMatchObject({ date: '2026-10-26', carriedOver: true });
    rollover.stop();
  });

  it('erreur de report absorbée : onCarryOverResult(true), le jour est quand même annoncé, pas de rejet', async () => {
    const failing = {
      ...db.data,
      repos: { ...db.data.repos, settings: { ...db.data.repos.settings, get: () => Promise.reject(new Error('boom')) } },
    } as typeof db.data;
    const results: boolean[] = [];
    const days: LocalDate[] = [];
    const rollover = createDayRollover(
      { clock: createManualClock(local(8, 23, 12)), data: failing, taskEntities: createTaskEntities() },
      { timers: fakeTimers().timers, onCarryOverResult: (f) => results.push(f), onDayChange: (d) => days.push(d) },
    );
    await expect(rollover.start()).resolves.toBeUndefined();
    expect(results).toEqual([true]);
    expect(days).toEqual(['2026-09-23']);
    rollover.stop();
  });

  it('minuterie le même jour : aucun report relancé (pas de transaction chaque minute), le jour suivant oui', async () => {
    await seed('2026-09-23');
    const results: boolean[] = [];
    const ft = fakeTimers();
    const rollover = createDayRollover(
      { clock: db.clock, data: db.data, taskEntities: createTaskEntities() },
      { timers: ft.timers, onCarryOverResult: (failed) => results.push(failed) },
    );
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    await rollover.start();
    expect(results).toHaveLength(1);

    db.clock.set(local(8, 23, 23, 31));
    ft.fire();
    await flush();
    expect(results).toHaveLength(1); // même jour : pas de nouvel essai
    expect(ft.pending()?.ms).toBe(60_000); // mais toujours ré-armé

    db.clock.set(local(8, 24, 0, 0));
    ft.fire();
    await flush();
    expect(results).toHaveLength(2); // jour changé : report relancé
    rollover.stop();
  });

  it('timers par défaut : s’appuie sur setTimeout global', async () => {
    vi.useFakeTimers();
    try {
      const rollover = createDayRollover({ clock: db.clock, data: db.data, taskEntities: createTaskEntities() });
      const started = rollover.start();
      await vi.advanceTimersByTimeAsync(0);
      await started;
      expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
      rollover.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
