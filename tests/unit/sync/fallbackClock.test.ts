import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '../../../src/domain/types';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../sim/syncDevice';
import { propagate } from '../../sim/syncCloudSim';

/**
 * Horloge de repli « * » (ADR 0011 section 3.2 ; Y-02 critère 2, revue du lot Y2 point 1) : dès qu'une ligne a une horloge de champ,
 * elle a aussi « * » ; sinon les champs sans horloge propre prennent le hlc de la ligne, qui avance à chaque écriture d'un autre champ,
 * et une écriture distante plus ancienne sur ces champs est refusée d'un seul côté : divergence permanente.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

const clocksOf = (d: SimDevice, id: string) => d.driver.select<{ field: string; hlc: string }>('SELECT field, hlc FROM sync_field_clock WHERE table_name = ? AND row_id = ? ORDER BY field', ['task', id]);

describe('horloge de repli « * » (revue Y2, point 1)', () => {
  it('A crée et modifie, instantané ; B rejoint, modifie la note ; A modifie le titre avec un hlc inférieur : les deux convergent', async () => {
    const a = await createSimDevice(A_ID, { start: '2026-10-05T08:00:00.000Z' });
    devices = [a];
    await setupFirst(a);
    await a.cycle();
    const t = await a.createTask('v1');
    a.clock.advance(60_000);
    await a.cycle();
    a.clock.advance(60_000);
    await a.updateTask(t.id, { title: 'v2' });
    await a.cycle();
    // Une semaine plus tard : instantané hebdomadaire de A.
    a.clock.advance(8 * 86_400_000);
    await a.cycle();
    // B rejoint avec une horloge en avance de 28 minutes sur A (sous la dérive admise d'une heure) : il reprend depuis l'instantané.
    const b = await createSimDevice(B_ID, { start: '2026-10-13T08:30:00.000Z' });
    devices.push(b);
    await pair(a, b);
    expect((await b.cycle()).phase).toBe('idle');
    expect((await b.task(t.id))?.title).toBe('v2');
    expect((await clocksOf(b, t.id)).some((c) => c.field === '*')).toBe(true);
    b.clock.advance(60_000);
    await b.updateTask(t.id as TaskId, { note: 'note B' });
    // A modifie le titre : son hlc est inférieur à celui de la note de B.
    a.clock.advance(60_000);
    await a.updateTask(t.id, { title: 'v3' });
    await a.cycle();
    await b.cycle();
    syncFolders(devices);
    await b.cycle();
    await a.cycle();
    expect((await b.task(t.id))?.title).toBe('v3');
    expect((await a.task(t.id))?.note).toBe('note B');
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });

  it('une ligne reçue complète porte « * » ; une modification locale ultérieure ne déplace pas l’horloge des autres champs', async () => {
    const a = await createSimDevice(A_ID);
    const b = await createSimDevice(B_ID, { clock: a.clock });
    devices = [a, b];
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    const t = await a.createTask('Titre');
    a.clock.advance(1_000);
    await a.updateTask(t.id, { note: 'n1' });
    await a.cycle();
    propagate(a.folder, b.folder, A_ID);
    await b.cycle();
    const received = await clocksOf(b, t.id);
    expect(received.some((c) => c.field === '*')).toBe(true);
    const star = received.find((c) => c.field === '*')?.hlc;
    a.clock.advance(1_000);
    await b.updateTask(t.id as TaskId, { status: 'done', doneAt: new Date(a.clock.nowMs()).toISOString() as never });
    const after = await clocksOf(b, t.id);
    expect(after.find((c) => c.field === '*')?.hlc).toBe(star);
  });
});
