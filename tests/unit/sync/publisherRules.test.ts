import { afterEach, describe, expect, it } from 'vitest';
import type { SqlExecutor, SqlParams } from '../../../src/db/driver';
import { createSqlRepositories, type Repositories } from '../../../src/db/repositories';
import { openTestDb } from '../../../src/db/repositories/sql/testSetup';
import { createWriteStamper, createHlcClock } from '../../../src/domain/hlc';
import { MAX_APPEND_CALL_BYTES } from '../../../src/domain/sync/format';
import { syncTable, type SyncTable } from '../../../src/domain/sync/syncTables';
import type { DeviceId, Hlc, LocalDate, SpaceId, TaskId } from '../../../src/domain/types';
import { batchRecords, materializeOutbox, type BuiltRecord } from '../../../src/sync/publisher';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * Publication (ADR 0011 sections 3.3 et 10.2 ; Y-02 critère 5, Y-05 critères 1 et 3 ; revue Y2 points 4, 5, 6 et 15) : retrait des
 * entrées sans publication par numéro, valeurs et horloges lues ensemble, un même hlc jamais coupé entre deux appels, lecture avant
 * publication dans le cycle.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SELF = '60000000-0000-4000-8000-0000000000c1' as DeviceId;
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function twoDevices(): Promise<[SimDevice, SimDevice]> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
  devices = [a, b];
  await setupFirst(a);
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  syncFolders(devices);
  await a.cycle();
  return [a, b];
}

describe('retrait des entrées sans publication (revue Y2, point 4)', () => {
  it('une écriture locale faite entre la lecture de la file et le retrait d’une entrée périmée du même champ est publiée', async () => {
    const [a, b] = await twoDevices();
    const t = await a.createTask('Titre de A');
    await a.cycle();
    syncFolders(devices);
    await b.cycle();
    // Entrée périmée chez B : le titre porte l'horloge de A (rien à publier).
    await b.driver.execute("INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('task', ?, 'title')", [t.id]);
    // L'utilisateur modifie le titre juste avant le retrait (dans la transaction qui retire, après la lecture de la file).
    let written = false;
    const transaction = b.data.transaction.bind(b.data);
    (b.data as { transaction: typeof transaction }).transaction = (work) =>
      transaction((repos) => {
        const sync = repos.sync;
        const wrapped: Repositories = {
          ...repos,
          sync: {
            ...sync,
            dropOutbox: async (entries) => {
              if (!written) {
                written = true;
                a.clock.advance(1_000);
                await repos.tasks.update(t.id, { title: 'Titre de B' });
              }
              return sync.dropOutbox(entries);
            },
          },
        };
        return work(wrapped);
      });
    await b.cycle();
    (b.data as { transaction: typeof transaction }).transaction = transaction;
    expect(written).toBe(true);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(t.id))?.title).toBe('Titre de B');
  });
});

describe('valeurs et horloges lues ensemble (revue Y2, point 5)', () => {
  /**
   * Exécuteur espion : si les horloges sont lues par une instruction **distincte** de celle des valeurs de `task`, une écriture locale
   * s'intercale entre les deux (une seule fois). Lues par une seule instruction, aucune écriture ne peut tomber entre elles.
   */
  async function interleaved(write: (db: SqlExecutor) => Promise<void>) {
    const db = await openTestDb(SELF, '2026-10-05T08:00:00.000Z');
    const stamper = createWriteStamper(db.clock, createHlcClock({ clock: db.clock, deviceId: SELF }));
    let armed = false;
    let valuesRead = false;
    let fired = false;
    const spy: SqlExecutor = {
      execute: (sql: string, params?: SqlParams) => db.driver.execute(sql, params),
      select: async (sql: string, params?: SqlParams) => {
        if (armed && /\bFROM task\b/.test(sql) && /\btitle\b/.test(sql)) valuesRead = true;
        else if (armed && valuesRead && !fired && /\bFROM sync_field_clock\b/.test(sql)) {
          fired = true;
          await write(db.driver);
        }
        return db.driver.select(sql, params);
      },
    };
    const repos = createSqlRepositories(spy, stamper);
    const task = await db.data.repos.tasks.create({
      id: '11111111-1111-4111-8111-111111111111' as TaskId,
      spaceId: PRO,
      projectId: null,
      title: 'Avant',
      note: '',
      date: '2026-10-05' as LocalDate,
      time: null,
      status: 'todo',
      doneAt: null,
      sortOrder: 1,
      carriedOver: false,
      recurrenceId: null,
      seriesIndex: null,
      seriesTemplate: null,
      goalId: null,
      icon: null,
      someday: false,
      source: 'local',
      externalId: null,
      externalEventId: null,
    });
    db.clock.advance(1_000);
    return {
      db,
      repos,
      task,
      arm: () => {
        armed = true;
      },
    };
  }

  const later = (db: Awaited<ReturnType<typeof openTestDb>>, id: string) => async (driver: SqlExecutor) => {
    const hlc = `${String(db.clock.nowMs()).padStart(15, '0')}-0000-${SELF}`;
    await driver.execute('UPDATE task SET title = ?, hlc = ?, updated_at = ? WHERE id = ?', ['Après', hlc, new Date(db.clock.nowMs()).toISOString(), id]);
  };

  it('publication : la valeur publiée d’un champ est celle de son horloge', async () => {
    let ctx: Awaited<ReturnType<typeof interleaved>> | null = null;
    ctx = await interleaved((driver) => later((ctx as NonNullable<typeof ctx>).db, (ctx as NonNullable<typeof ctx>).task.id)(driver));
    try {
      ctx.arm();
      const material = await materializeOutbox(ctx.repos, SELF, null);
      const title = material.ops.flatMap((p) => [...p.op.f.entries()]).find(([name]) => name === 'title')?.[1];
      expect(title).toBeDefined();
      const clocks = await ctx.db.driver.select<{ field: string; hlc: string }>("SELECT field, hlc FROM sync_field_clock WHERE row_id = ? AND field = 'title'", [ctx.task.id]);
      const newHlc = clocks[0]?.hlc;
      // Soit l'ancienne valeur avec l'ancienne horloge, soit la nouvelle avec la nouvelle ; jamais un mélange.
      if (title?.[0] === 'Avant') expect(title[1]).toBe(ctx.task.hlc);
      else expect(title?.[1]).toBe(newHlc);
    } finally {
      await ctx.db.close();
    }
  });

  it('instantané et report d’époque : exportRows rend des valeurs et des horloges cohérentes', async () => {
    let ctx: Awaited<ReturnType<typeof interleaved>> | null = null;
    ctx = await interleaved((driver) => later((ctx as NonNullable<typeof ctx>).db, (ctx as NonNullable<typeof ctx>).task.id)(driver));
    try {
      ctx.arm();
      const [row] = await ctx.repos.sync.exportRows(syncTable('task') as SyncTable, null, 10);
      const title = row?.values.get('title');
      const clock = row?.clocks.get('title')?.hlc ?? row?.clocks.get('*')?.hlc ?? row?.hlc;
      if (title === 'Avant') expect(clock).toBe(ctx.task.hlc);
      else expect(clock).not.toBe(ctx.task.hlc);
    } finally {
      await ctx.db.close();
    }
  });
});

describe('un même hlc jamais coupé entre deux appels (revue Y2, point 6)', () => {
  const h = (n: number): Hlc => `${String(1_791_187_200_000 + n).padStart(15, '0')}-0000-${SELF}` as Hlc;
  const rec = (hlc: Hlc, bytes: number): BuiltRecord => ({ text: 'x', maxHlc: hlc, bytes });

  it('les enregistrements d’un même hlc partent dans le même appel', () => {
    const third = Math.floor(MAX_APPEND_CALL_BYTES * 0.3);
    const batches = batchRecords([rec(h(1), 2 * third), rec(h(2), third), rec(h(2), third)]);
    const callsOf = (hlc: Hlc) => batches.filter((batch) => batch.some((r) => r.maxHlc === hlc)).length;
    expect(callsOf(h(1))).toBe(1);
    expect(callsOf(h(2))).toBe(1);
    for (const batch of batches) expect(batch.reduce((n, r) => n + r.bytes, 0)).toBeLessThanOrEqual(MAX_APPEND_CALL_BYTES);
  });

  it('un groupe d’un même hlc plus grand qu’un appel est refusé et signalé, les autres partent', () => {
    const refused: Hlc[] = [];
    const half = Math.floor(MAX_APPEND_CALL_BYTES / 2) + 10;
    const batches = batchRecords([rec(h(1), 100), rec(h(2), half), rec(h(2), half), rec(h(3), 100)], (hlc) => refused.push(hlc));
    expect(refused).toEqual([h(2)]);
    expect(batches.flat().map((r) => r.maxHlc)).toEqual([h(1), h(3)]);
  });
});

describe('ordre du cycle : lecture puis publication (ADR 0011 §10.2 ; revue Y2, point 15)', () => {
  it('avec un enregistrement à lire et une écriture à publier, la lecture précède la publication', async () => {
    const [a, b] = await twoDevices();
    await a.createTask('À lire');
    await a.cycle();
    syncFolders(devices);
    await b.createTask('À publier');
    const calls: string[] = [];
    const read = b.platform.readJournal.bind(b.platform);
    const append = b.platform.appendJournal.bind(b.platform);
    b.platform.readJournal = async (r) => {
      calls.push('read');
      return read(r);
    };
    b.platform.appendJournal = async (r) => {
      calls.push('append');
      return append(r);
    };
    await b.cycle();
    expect(calls).toContain('read');
    expect(calls).toContain('append');
    expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('append'));
    expect(calls.lastIndexOf('read')).toBeLessThan(calls.indexOf('append'));
  });
});
