import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { RoutineId } from '../../../src/domain/types';
import { createAppContainer, type AppContainer } from '../../../src/features/app/container';
import { createTaskUseCases } from '../../../src/features/tasks/createTaskUseCases';
import { SyncPlatformError, type SyncErrorCode } from '../../../src/platform/sync/types';
import { PRO, createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/** Je travaille hors ligne (ADR 0011, sections 3.2, 6.2, 7.1 ; Y-05 critères 1 à 4, 8 et 9). */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: createManualClock(a.clock.nowMs()) });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

const containerOf = (d: SimDevice): AppContainer => createAppContainer({ clock: d.clock, hlc: d.hlc, data: d.data, sync: d.service });

describe('file d’envoi (Y-05 critère 1)', () => {
  it('création, modification, suppression, restauration de tâche, routine, réglage partagé : dans la file jusqu’à la publication', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Hors ligne');
    a.clock.advance(1);
    await a.updateTask(t.id, { title: 'Hors ligne bis' });
    a.clock.advance(1);
    await a.deleteTask(t.id);
    a.clock.advance(1);
    await a.data.repos.tasks.restore([t.id]);
    await a.data.repos.routines.create({ id: '33333333-3333-4333-8333-333333333333' as RoutineId, spaceId: PRO, title: 'Lire', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: '2026-10-05', time: null, archived: false } as never);
    await a.data.repos.settings.set('general.firstWeekday', 'sunday');
    await a.data.repos.settings.set('ui.theme', 'dark');
    const queued = await a.data.repos.sync.readOutbox();
    expect(new Set(queued.map((e) => e.table))).toEqual(new Set(['task', 'routine', 'settings']));
    expect(queued.some((e) => e.rowId === 'ui.theme')).toBe(false);
    await a.cycle();
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Hors ligne bis');
    expect(await b.data.repos.settings.get('general.firstWeekday')).toBe('sunday');
    expect(await b.data.repos.settings.get('ui.theme')).toBe('system');
  });
});

describe('cycle en échec (Y-05 critère 2)', () => {
  it.each<[SyncErrorCode, string]>([
    ['folder-unreachable', 'error'],
    ['cloud-provider-stopped', 'error'],
    ['io', 'error'],
    ['cloud-pending', 'waiting-icloud'],
  ])('%s : rien n’est retiré de la file, phase %s avec le code, le cycle suivant réessaie', async (code, phase) => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Pendant la panne');
    const scan = vi.spyOn(a.platform, 'scan').mockRejectedValue(new SyncPlatformError(code));
    const status = await a.cycle();
    expect(status.phase).toBe(phase);
    expect(status.errorCode).toBe(code);
    expect(await a.data.repos.sync.outboxCount()).toBe(1);
    // L'app reste utilisable pendant la panne.
    await a.createTask('Encore utilisable');
    scan.mockRestore();
    expect((await a.cycle()).phase).toBe('idle');
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(t.id))?.title).toBe('Pendant la panne');
  });

  it('dossier local sans réseau : la publication réussit et l’état est « À jour » (D1)', async () => {
    const [a] = await twoDevices();
    await a.createTask('Sans réseau');
    expect((await a.cycle()).phase).toBe('idle');
    expect(await a.data.repos.sync.outboxCount()).toBe(0);
  });
});

describe('retour en ligne (Y-05 critères 3 et 4, parcours 10)', () => {
  it('A et B hors ligne : deux champs différents gardés ; même champ : plus grand hlc gagne, l’autre dans conflict_log des deux côtés', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Partagée');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    // Hors ligne : chacun modifie, rien n'est recopié.
    a.clock.advance(1_000);
    b.clock.advance(2_000);
    await a.updateTask(t.id, { title: 'Titre du PC', note: 'note du PC' });
    await b.updateTask(t.id, { title: 'Titre de l’iPhone', date: '2026-10-06' as never });
    await a.cycle();
    await b.cycle();
    // Retour : publication puis lecture.
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.title, d.name).toBe('Titre de l’iPhone');
      expect(row?.note, d.name).toBe('note du PC');
      expect(row?.date, d.name).toBe('2026-10-06');
    }
    const log = (d: SimDevice) => d.driver.select('SELECT field, kept_value, discarded_value, kept_device, discarded_device FROM conflict_log');
    expect(await log(a)).toEqual([{ field: 'title', kept_value: '"Titre de l’iPhone"', discarded_value: '"Titre du PC"', kept_device: B_ID, discarded_device: A_ID }]);
    expect(await log(b)).toEqual(await log(a));
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});

describe('annulation après publication (Y-05 critère 8, T-13)', () => {
  it('l’annulation est une nouvelle écriture publiée ; si l’autre appareil a modifié la ligne entre-temps, elle est refusée (stale)', async () => {
    const [a, b] = await twoDevices();
    const ca = containerOf(a);
    const useCases = createTaskUseCases(ca);
    const created = await useCases.create({ title: 'À annuler', spaceId: PRO, date: '2026-10-05' as never });
    if (!created.ok) throw new Error('création');
    a.clock.advance(1_000);
    await useCases.remove([created.value.id]);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(created.value.id))?.deletedAt).not.toBeNull();
    expect((await ca.undo.undoLast()).status).toBe('undone');
    a.clock.advance(1_000);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect((await b.task(created.value.id))?.deletedAt).toBeNull();
    // Nouvelle suppression, puis B modifie la tâche avant que A n'annule : refus.
    a.clock.advance(1_000);
    await useCases.remove([created.value.id]);
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    b.clock.advance(5_000);
    await b.data.repos.tasks.restore([created.value.id]);
    await b.updateTask(created.value.id, { title: 'Modifiée par l’iPhone' });
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    expect((await ca.undo.undoLast()).status).toBe('stale');
    expect((await a.task(created.value.id))?.title).toBe('Modifiée par l’iPhone');
  });
});
