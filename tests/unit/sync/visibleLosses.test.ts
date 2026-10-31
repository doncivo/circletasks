import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { SyncField, SyncOp } from '../../../src/domain/sync/format';
import type { Hlc, IsoDateTime } from '../../../src/domain/types';
import { applyOps } from '../../../src/sync/apply';
import { guarded } from '../../../src/sync/guarded';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * TRI-06 et TRI-04 (tri des importants du 2026-10-30) : deux pertes qui ne laissaient qu'une ligne de journal. Une note de plus de 256 Kio
 * n'est jamais publiée (`publish-too-large`) ; une opération reçue en attente de son parent est abandonnée au plafond de 10 000
 * (`cap-dropped`). Rendre l'échec visible seulement : compteur persistant et ligne d'avertissement, jamais de traitement du cas.
 */
const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
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

const AT = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const HLC = `1791187200100-0000-${B_ID}` as Hlc;

/** Une tâche complète dont le projet n'existe pas chez le destinataire : mise de côté en `missing-parent`. */
function childOfMissingProject(): SyncOp {
  const f: Record<string, SyncField> = {
    space_id: ['00000000-0000-4000-8000-000000000001', HLC, null],
    project_id: ['33333333-3333-4333-8333-333333333333', HLC, null],
    title: ['Orpheline', HLC, null],
    note: ['', HLC, null],
    date: ['2026-10-05', HLC, null],
    time: [null, HLC, null],
    status: ['todo', HLC, null],
    done_at: [null, HLC, null],
    sort_order: [1, HLC, null],
    carried_over: [0, HLC, null],
    recurrence_id: [null, HLC, null],
    series_index: [null, HLC, null],
    goal_id: [null, HLC, null],
    icon: [null, HLC, null],
    someday: [0, HLC, null],
    source: ['local', HLC, null],
    external_id: [null, HLC, null],
    series_template: [null, HLC, null],
    external_event_id: [null, HLC, null],
    apple_list_id: [null, HLC, null],
    apple_recurring: [0, HLC, null],
    created_at: [AT, HLC, null],
    deleted_at: [null, HLC, null],
  };
  return { t: 'task', id: '22222222-2222-4222-8222-222222222222', at: AT, f: new Map(Object.entries(f)) };
}

const series = (count: number): string => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(count)})`;

describe('TRI-06 : une note trop grosse pour être publiée est signalée', () => {
  it('l’avertissement « publish-dropped » est levé, sans contenu au journal, et survit à un redémarrage', async () => {
    const [a] = await twoDevices();
    a.clock.advance(1_000);
    await a.createTask('Grosse note', { note: 'x'.repeat(300_000) });
    const status = await a.cycle();
    expect(a.logger.entries.some((e) => e.event === 'publish-too-large')).toBe(true);
    expect(status.warnings ?? []).toContain('publish-dropped');
    expect(JSON.stringify(a.logger.entries)).not.toContain('xxxxxxxx');
    await a.restart();
    const after = await a.cycle();
    expect(after.warnings ?? []).toContain('publish-dropped');
  });

  it('garde-fou : une note qui tient ne lève rien', async () => {
    const [a] = await twoDevices();
    a.clock.advance(1_000);
    await a.createTask('Petite note', { note: 'x'.repeat(10_000) });
    const status = await a.cycle();
    expect(status.warnings ?? []).not.toContain('publish-dropped');
  });
});

describe('TRI-04 : une opération en attente de son parent, abandonnée au plafond, est signalée', () => {
  it('le dépassement de 10 000 opérations mises de côté lève « received-unapplied » et survit à un redémarrage', async () => {
    const [a] = await twoDevices();
    await guarded(a.data, (repos) => applyOps(repos, [childOfMissingProject()], { localSv: 18, remoteSv: 18, now: AT, knows: () => false, logger: a.logger }));
    expect(await a.driver.select("SELECT reason FROM sync_parked")).toEqual([{ reason: 'missing-parent' }]);
    await a.driver.execute(
      `${series(10_004)} INSERT INTO sync_parked (reason, table_name, row_id, hlc, op, parked_at) SELECT reason, table_name, row_id || i, hlc, op, parked_at FROM n, (SELECT * FROM sync_parked LIMIT 1)`,
    );
    const status = await a.cycle();
    expect(a.logger.entries.filter((e) => e.event === 'cap-dropped')).toHaveLength(5);
    expect(status.warnings ?? []).toContain('received-unapplied');
    await a.restart();
    const after = await a.cycle();
    expect(after.warnings ?? []).toContain('received-unapplied');
  });

  it('garde-fou : sous le plafond, rien n’est levé', async () => {
    const [a] = await twoDevices();
    const status = await a.cycle();
    expect(status.warnings ?? []).not.toContain('received-unapplied');
  });
});
