import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EpochCarryReport } from '../../../src/domain/sync/epochCarryReport';
import { syncTable } from '../../../src/domain/sync/syncTables';
import type { DeviceId, IsoDateTime, LocalTime } from '../../../src/domain/types';
import { createSimDevice, pair, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { A_ID, B_ID, applyEverywhere, backupOf, rounds, twoDevices } from './epochCarryKit';

/**
 * Y-TECH-05, critère 23 : banc à trois appareils, restauration « Appliquer partout » avec un troisième auteur. A (PC, ouvreur) restaure
 * une sauvegarde, B (iPhone) reporte, C (ancien PC, troisième auteur non oublié) a écrit ce que A n'a jamais lu.
 * (i) « Test Pc » créée par C, non lue par A, détenue par B ; (ii) « À jeter » supprimée par A à un instant connu (avant la sauvegarde),
 * puis restaurée par C sans que A l'ait lu ; (iii) « Annulée par la restauration » supprimée par A après la sauvegarde ; (iv) 3 champs de
 * C et 2 de B sur une ligne vivante (« Vivante »). Le compte rendu de B est comparé en entier (égalité de structure).
 */

const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
/** Colonnes publiées d'une tâche : « Test Pc » recréée est reportée entière (toutes ses colonnes portent l'horloge de C). */
const TASK_COLUMNS = syncTable('task')?.columns.length ?? 0;

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

interface Scenario {
  readonly a: SimDevice;
  readonly b: SimDevice;
  readonly c: SimDevice;
  readonly ids: { readonly jeter: string; readonly annulee: string; readonly vivante: string; readonly testPc: string };
  /** Instant (ISO) de la suppression de « À jeter » par A. */
  readonly deletedAt: IsoDateTime;
  /** Époque ouverte par A. */
  readonly target: string;
}

/** Le scénario jusqu'au cycle de B qui change d'époque (non compris). */
async function scenario(): Promise<Scenario> {
  const [a, b] = await twoDevices();
  const c = await createSimDevice(C_ID, { name: 'Ancien PC', clock: a.clock });
  devices = [a, b, c];
  await pair(a, c);
  await c.cycle();
  syncFolders(devices);
  await rounds(devices, 2);

  a.clock.advance(60_000);
  const jeter = await a.createTask('À jeter');
  const annulee = await a.createTask('Annulée par la restauration');
  const vivante = await a.createTask('Vivante');
  await rounds(devices, 2);
  // (ii) A supprime « À jeter » à un instant connu ; tous le lisent ; la sauvegarde de A suit.
  a.clock.advance(60_000);
  const deletedAt = new Date(a.clock.nowMs()).toISOString() as IsoDateTime;
  await a.deleteTask(jeter.id);
  await rounds(devices, 2);
  const copy = await backupOf(a);
  // (iii) A supprime « Annulée par la restauration » après la sauvegarde ; B et C le lisent.
  a.clock.advance(60_000);
  await a.deleteTask(annulee.id);
  await rounds(devices, 2);

  // A ne lit plus rien de B ni de C : leurs dossiers ne s'échangent qu'entre eux.
  a.clock.advance(60_000);
  await c.data.repos.tasks.restore([jeter.id]);
  const testPc = await c.createTask('Test Pc');
  await c.updateTask(vivante.id, { title: 'Vivante (C)', note: 'note de C', date: '2026-10-06' as never });
  await c.cycle();
  syncFolders([b, c]);
  await b.cycle();
  a.clock.advance(60_000);
  await b.updateTask(vivante.id, { time: '09:30' as LocalTime, sortOrder: 99 });
  await b.cycle();
  syncFolders([b, c]);
  await c.cycle();
  syncFolders([b, c]);

  // Départ : ce que chacun détient avant la restauration.
  expect((await a.task(jeter.id))?.deletedAt, 'À jeter supprimée chez A').not.toBeNull();
  expect((await b.task(jeter.id))?.deletedAt, 'À jeter restaurée par C, lue par B').toBeNull();
  expect(await a.task(testPc.id), 'Test Pc jamais lue par A').toBeNull();
  expect((await b.task(testPc.id))?.title).toBe('Test Pc');
  expect((await b.task(annulee.id))?.deletedAt, 'Annulée supprimée chez B').not.toBeNull();
  expect(await b.task(vivante.id)).toMatchObject({ title: 'Vivante (C)', note: 'note de C', time: '09:30', sortOrder: 99 });

  await applyEverywhere(a, copy);
  syncFolders(devices);
  const target = JSON.parse((await a.data.repos.sync.getMeta('epoch')) ?? 'null') as string;
  return { a, b, c, ids: { jeter: jeter.id, annulee: annulee.id, vivante: vivante.id, testPc: testPc.id }, deletedAt, target };
}

const reportsOf = async (d: SimDevice): Promise<EpochCarryReport[]> => (await d.data.repos.carryReports()).list(20);

describe('Y-TECH-05 : compte rendu du report d’époque, banc à trois appareils (critère 23)', () => {
  it('critère 23 : le compte rendu de B contient exactement les compteurs par auteur, « À jeter » rétablie, « Test Pc » recréée, rien d’autre', async () => {
    const s = await scenario();
    const createdAt = new Date(s.b.clock.nowMs()).toISOString();
    await s.b.cycle();
    const reports = await reportsOf(s.b);
    expect(reports).toEqual([
      {
        id: expect.any(Number) as number,
        epoch: s.target,
        cause: 'restore',
        reporter: B_ID,
        opener: A_ID,
        mode: 'replace',
        createdAt,
        authors: [
          // B : 2 champs sur « Vivante ».
          { device: B_ID, fields: 2, rows: 1, tombs: 0, late: 0 },
          // C : « Test Pc » entière, `deleted_at` de « À jeter », 3 champs de « Vivante ».
          { device: C_ID, fields: TASK_COLUMNS + 1 + 3, rows: 3, tombs: 0, late: 0 },
        ],
        restored: [{ table: 'task', rowId: s.ids.jeter, label: 'À jeter', by: C_ID, deletedAt: s.deletedAt, deletedBy: A_ID }],
        recreated: [{ table: 'task', rowId: s.ids.testPc, label: 'Test Pc', by: C_ID, deletedAt: null, deletedBy: null }],
        parentReplaced: [],
        overflow: 0,
        banner: true,
        acknowledgedAt: null,
        damaged: false,
      },
    ]);
    // (iii) : la suppression de A annulée par la restauration n'est dans aucune liste (assertion explicite, critère 4).
    const named = reports.flatMap((r) => [...r.restored, ...r.recreated].map((item) => item.rowId));
    expect(named).not.toContain(s.ids.annulee);
    expect((await s.b.task(s.ids.annulee as never))?.deletedAt).toBeNull();
  });
});
