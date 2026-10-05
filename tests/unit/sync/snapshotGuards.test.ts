import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { DeviceId, HexColor, ProjectId, SpaceId } from '../../../src/domain/types';
import { openTestDb } from '../../../src/db/repositories/sql/testSetup';
import { PRO, createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';

/**
 * Instantanés (ADR 0011 sections 4.4, 5.4, 5.5 ; Y-09 critères 7 et 10 ; revue Y2 points 10 et 11) : contrôle de dérive et réception
 * du plus grand hlc avant application ; graine de l'horloge (`maxHlc`) sur toutes les tables publiées et les horloges de champ ; trace
 * d'une ligne qui a encore des enfants écartée (journalisée) au lieu de faire échouer la reprise à chaque cycle.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DAY = 86_400_000;
const HOUR = 3_600_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** A seul ; 8 jours plus tard, une tâche puis le cycle qui écrit l'instantané hebdomadaire (il la contient, hlc récent). */
async function ownerWithSnapshot(): Promise<{ a: SimDevice; taskId: string }> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  devices = [a];
  await setupFirst(a);
  await a.cycle();
  a.clock.advance(8 * DAY);
  const t = await a.createTask('Depuis A');
  await a.cycle();
  return { a, taskId: t.id };
}

describe('instantané : horloge (revue Y2, point 10)', () => {
  it('reprise : le plus grand hlc de l’instantané est reçu ; une modification locale juste après l’emporte partout', async () => {
    const { a, taskId } = await ownerWithSnapshot();
    // B en retard de 30 minutes sur A (sous la dérive admise) : sans réception, ses écritures auraient des hlc plus petits que ceux de A.
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: createManualClock(a.clock.nowMs() - 30 * 60_000) });
    devices.push(b);
    await pair(a, b);
    expect((await b.cycle()).phase).toBe('idle');
    await b.updateTask(taskId as never, { title: 'Modifiée par B après la reprise' });
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(taskId as never))?.title).toBe('Modifiée par B après la reprise');
    expect((await b.task(taskId as never))?.title).toBe('Modifiée par B après la reprise');
  });

  it('instantané écrit par une horloge en avance de plus d’une heure : refusé, phase clock-ahead ; appliqué quand la condition cesse', async () => {
    const { a, taskId } = await ownerWithSnapshot();
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: createManualClock(a.clock.nowMs() - 2 * HOUR) });
    devices.push(b);
    await pair(a, b);
    const status = await b.cycle();
    expect(status.phase).toBe('clock-ahead');
    expect(status.clockAheadDevice).toBe(A_ID);
    expect(await b.task(taskId as never)).toBeNull();
    expect(b.logger.entries.some((e) => e.event === 'snapshot-clock-ahead')).toBe(true);
    // L'horloge de B n'a pas été poussée par le hlc aberrant.
    const mine = await b.createTask('Locale');
    expect(mine.hlc < ((await a.task(taskId as never))?.hlc ?? '')).toBe(true);
    b.clock.advance(2 * HOUR);
    expect((await b.cycle()).phase).toBe('idle');
    expect((await b.task(taskId as never))?.title).toBe('Depuis A');
  });

  it('graine de l’horloge : maxHlc couvre routine_pause, calendar_account et les horloges de champ', async () => {
    const db = await openTestDb('60000000-0000-4000-8000-0000000000c1' as DeviceId);
    try {
      const high = (n: number): string => `${String(1_900_000_000_000 + n).padStart(15, '0')}-0000-${B_ID}`;
      await db.driver.execute('INSERT INTO sync_guard (id) VALUES (1)');
      await db.driver.execute('INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc) VALUES (?, ?, ?, ?, NULL)', ['task', 'x', 'title', high(1)]);
      expect(await db.data.repos.syncMeta.maxHlc()).toBe(high(1));
      await db.driver.execute(
        "INSERT INTO calendar_account (id, provider, label, calendars, created_at, updated_at, device_id, hlc) VALUES ('c1', 'google', 'x', '[]', '2026-10-01T08:00:00.000Z', '2026-10-01T08:00:00.000Z', ?, ?)",
        [B_ID, high(2)],
      );
      expect(await db.data.repos.syncMeta.maxHlc()).toBe(high(2));
      await db.driver.execute('DELETE FROM sync_guard');
    } finally {
      await db.close();
    }
  });
});

describe('instantané : trace d’un parent qui a encore des enfants (revue Y2, point 11 ; décision (c))', () => {
  it('projet purgé chez A, tâche créée dessous par B hors ligne : B la rattache à « Sans projet » et la republie entière, convergence', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: createManualClock(a.clock.nowMs()) });
    devices = [a, b];
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    const projectId = '70000000-0000-4000-8000-000000000001' as ProjectId;
    await a.data.repos.projects.create({ id: projectId, spaceId: PRO as SpaceId, name: 'Projet', color: '#123456' as HexColor, archived: false, sortOrder: 1 });
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    expect(await b.data.repos.projects.getById(projectId)).not.toBeNull();
    // B part 200 jours avec une tâche créée hors ligne dans le projet ; A supprime le projet, le purge (B expiré), écrit des instantanés.
    const offline = await b.createTask('Hors ligne dans le projet', { projectId });
    a.clock.advance(1_000);
    await a.data.repos.projects.softDelete(projectId);
    await a.cycle();
    a.clock.advance(200 * DAY);
    await a.cycle();
    await a.cycle();
    expect(await a.data.repos.projects.getById(projectId, { includeDeleted: true })).toBeNull();
    // Instantané hebdomadaire suivant : il porte la trace du projet.
    a.clock.advance(8 * DAY);
    await a.cycle();
    b.clock.advance(208 * DAY);
    syncFolders(devices);
    expect((await b.cycle()).phase).toBe('idle');
    // Décision (c) : la tâche vivante passe à « Sans projet » du même espace, le projet est purgé chez B aussi, rien n'est perdu.
    expect(b.logger.entries.some((e) => e.event === 'children-reattached')).toBe(true);
    const onB = await b.task(offline.id);
    expect(onB?.title).toBe('Hors ligne dans le projet');
    expect(onB?.projectId).toBeNull();
    expect(onB?.spaceId).toBe(PRO);
    expect(await b.data.repos.projects.getById(projectId, { includeDeleted: true })).toBeNull();
    // Le cycle suivant n'échoue pas (plus de boucle d'échecs) et publie la tâche entière ; A la reçoit sous « Sans projet ».
    expect((await b.cycle()).phase).toBe('idle');
    syncFolders(devices);
    await a.cycle();
    await b.cycle();
    const onA = await a.task(offline.id);
    expect(onA?.title).toBe('Hors ligne dans le projet');
    expect(onA?.projectId).toBeNull();
    expect(await taskSnapshot(a)).toEqual(await taskSnapshot(b));
  });
});
