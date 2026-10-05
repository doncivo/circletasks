import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import { createAppContainer } from '../../../src/features/app/container';
import { createTrashUseCases } from '../../../src/features/tasks/trashUseCases';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';
// Simulation à deux bases SQLite Wasm : marge pour une machine chargée (plusieurs lots en parallèle).
vi.setConfig({ testTimeout: 30_000 });

/** Un élément supprimé ne réapparaît jamais (ADR 0011, sections 3.4, 4.2, 4.4, 5.4, 5.5 ; Y-09 critères 1 à 4, 6, 7, 10, 11). */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
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

/** Avance les deux horloges (appareils allumés en même temps). */
const advance = (ms: number): void => {
  for (const d of devices) d.clock.advance(ms);
};

/** Tour complet : cycles et recopies jusqu'à stabilité. */
async function roundTrip(): Promise<void> {
  for (let i = 0; i < 2; i += 1) {
    for (const d of devices) await d.cycle();
    syncFolders(devices);
  }
}

describe('suppression (Y-09 critère 1)', () => {
  it('la suppression circule comme un champ deleted_at ; restaurer la restaure partout', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('À supprimer');
    await roundTrip();
    advance(1_000);
    await a.deleteTask(t.id);
    await roundTrip();
    expect((await b.task(t.id))?.deletedAt).not.toBeNull();
    expect((await b.data.repos.tasks.listTrash(new Date(b.clock.nowMs() - 30 * DAY).toISOString() as never, 'all')).map((x) => x.id)).toEqual([t.id]);
    advance(1_000);
    await b.data.repos.tasks.restore([t.id]);
    await roundTrip();
    expect((await a.task(t.id))?.deletedAt).toBeNull();
  });

  it('modification hors ligne d’un élément supprimé ailleurs : la suppression plus récente gagne, la modification est gardée dans la ligne, conflit inscrit', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Partagée');
    await roundTrip();
    advance(1_000);
    await b.updateTask(t.id, { note: 'note hors ligne' });
    advance(1_000);
    await a.deleteTask(t.id);
    await roundTrip();
    for (const d of devices) {
      const row = await d.task(t.id);
      expect(row?.deletedAt, d.name).not.toBeNull();
      expect(row?.note, d.name).toBe('note hors ligne');
    }
    const conflicts = await a.driver.select<{ field: string }>('SELECT field FROM conflict_log');
    expect(conflicts.map((c) => c.field)).toContain('deleted_at');
  });
});

describe('purge (Y-09 critères 2, 3, 6, 11)', () => {
  it('31 jours mais pas lue par B : gardée ; lue par tous et 30 jours : purgée, trace sans contenu ; une opération ancienne ne ressuscite rien', async () => {
    const [a] = await twoDevices();
    const t = await a.createTask('Ancienne');
    await roundTrip();
    advance(1_000);
    await a.deleteTask(t.id);
    await a.cycle();
    advance(31 * DAY);
    await a.cycle();
    expect(await a.task(t.id)).not.toBeNull();
    // B lit la suppression et publie son accusé ; A le lit : purge.
    await roundTrip();
    await a.cycle();
    expect(await a.task(t.id)).toBeNull();
    const tombs = await a.driver.select('SELECT * FROM sync_tombstone');
    expect(tombs).toHaveLength(1);
    expect(Object.keys(tombs[0] ?? {}).sort()).toEqual(['deleted_hlc', 'purged_at', 'row_id', 'table_name']);
    expect(await a.driver.select("SELECT * FROM sync_outbox WHERE row_id = ?", [t.id])).toEqual([]);
    expect(await a.driver.select('SELECT * FROM sync_field_clock WHERE row_id = ?', [t.id])).toEqual([]);
    // L'état publié porte le plus grand hlc purgé (règle 4).
    expect(a.folder.fileNames(A_ID)).toContain('state.ctx');
    expect(await a.data.repos.sync.getMeta('purgeHorizon')).not.toBeNull();
    // Un appareil tiers qui rejoint reçoit la liste des identifiants purgés dans l'instantané.
    const c = await createSimDevice(C_ID, { clock: createManualClock(a.clock.nowMs()) });
    devices.push(c);
    advance(8 * DAY);
    await a.cycle();
    await pair(a, c);
    await c.cycle();
    expect(await c.driver.select('SELECT row_id FROM sync_tombstone')).toEqual([{ row_id: t.id }]);
    expect(await c.task(t.id)).toBeNull();
  });

  it('corbeille T-08 : sans synchro, purge à 30 jours inchangée ; avec synchro, une suppression non lue par tous reste en base', async () => {
    const [a] = await twoDevices();
    const t = await a.createTask('Corbeille');
    await a.deleteTask(t.id);
    advance(31 * DAY);
    const withSync = createAppContainer({ clock: a.clock, hlc: a.hlc, data: a.data, sync: a.service });
    expect(await createTrashUseCases(withSync).purgeExpired()).toBe(0);
    expect(await a.task(t.id)).not.toBeNull();
    const alone = await createSimDevice('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    devices.push(alone);
    const u = await alone.createTask('Seule');
    await alone.deleteTask(u.id);
    alone.clock.advance(31 * DAY);
    const plain = createAppContainer({ clock: alone.clock, hlc: alone.hlc, data: alone.data });
    expect(await createTrashUseCases(plain).purgeExpired()).toBe(1);
    expect(await alone.task(u.id)).toBeNull();
  });
});

describe('appareil absent (Y-09 critère 7) et horloge en avance (critère 10)', () => {
  it('absent plus de 180 jours : expired chez les autres ; à son retour, reprise depuis l’instantané en fusion, rien ne réapparaît, ses modifications hors ligne sont gardées', async () => {
    const [a, b] = await twoDevices();
    const gone = await a.createTask('Supprimée ailleurs');
    const kept = await a.createTask('Gardée');
    await roundTrip();
    // B part 200 jours avec une modification hors ligne ; A supprime une tâche, la purge (B expiré), écrit des instantanés.
    await b.updateTask(kept.id, { note: 'écrit hors ligne' });
    advance(1_000);
    await a.deleteTask(gone.id);
    await a.cycle();
    a.clock.advance(200 * DAY);
    await a.cycle();
    await a.cycle();
    expect(await a.task(gone.id)).toBeNull();
    const row = await a.driver.select<{ status: string }>('SELECT status FROM sync_state WHERE device_id = ?', [B_ID]);
    expect(row[0]?.status).toBe('expired');
    b.clock.advance(200 * DAY);
    syncFolders(devices);
    await b.cycle();
    expect(b.logger.entries.some((e) => e.event === 'resumed-from-snapshot')).toBe(true);
    expect(await b.task(gone.id)).toBeNull();
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(kept.id))?.note).toBe('écrit hors ligne');
  });

  it('horloge de B en avance de plus d’une heure : lecture de B arrêtée avant, phase clock-ahead ; reprise quand la condition cesse', async () => {
    const [a, b] = await twoDevices();
    b.clock.advance(2 * 3_600_000);
    const t = await b.createTask('Du futur');
    await b.cycle();
    syncFolders(devices);
    const status = await a.cycle();
    expect(status.phase).toBe('clock-ahead');
    expect(status.clockAheadDevice).toBe(B_ID);
    expect(await a.task(t.id)).toBeNull();
    // La publication locale n'est jamais bloquée, et l'horloge locale n'a pas été poussée par le hlc aberrant.
    const mine = await a.createTask('Locale');
    expect(mine.hlc < t.hlc).toBe(true);
    a.clock.advance(2 * 3_600_000);
    expect((await a.cycle()).phase).toBe('idle');
    expect((await a.task(t.id))?.title).toBe('Du futur');
  });
});
