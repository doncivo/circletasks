import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TaskId } from '../../../src/domain/types';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * Propriétés du moteur complet (ADR 0011, section 12 ; Y-02 critère 7, Y-05 critère 3, Y-09 critère 9) : deux appareils, écritures
 * hors ligne aléatoires, recopies iCloud et cycles dans un ordre aléatoire, puis synchro complète. Convergence, aucune perte (chaque
 * champ final = valeur au plus grand hlc parmi toutes les écritures), un élément supprimé et non restauré l'est partout.
 */

const IDS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] as const;
const TASKS_DYNAMIC: TaskId[] = [];
const TASKS = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'] as TaskId[];

type Step =
  | { readonly kind: 'title' | 'note'; readonly device: 0 | 1; readonly task: 0 | 1; readonly value: string }
  | { readonly kind: 'delete' | 'restore'; readonly device: 0 | 1; readonly task: 0 | 1 }
  | { readonly kind: 'create'; readonly device: 0 | 1; readonly value: string }
  | { readonly kind: 'cycle'; readonly device: 0 | 1 }
  | { readonly kind: 'propagate'; readonly from: 0 | 1 }
  | { readonly kind: 'tick'; readonly ms: number };

const dev = fc.constantFrom<0 | 1>(0, 1);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constantFrom<'title' | 'note'>('title', 'note'), device: dev, task: dev, value: fc.string({ minLength: 1, maxLength: 3 }) }),
  fc.record({ kind: fc.constantFrom<'delete' | 'restore'>('delete', 'restore'), device: dev, task: dev }),
  fc.record({ kind: fc.constant<'cycle'>('cycle'), device: dev }),
  fc.record({ kind: fc.constant<'create'>('create'), device: dev, value: fc.string({ minLength: 1, maxLength: 3 }) }),
  fc.record({ kind: fc.constant<'propagate'>('propagate'), from: dev }),
  fc.record({ kind: fc.constant<'tick'>('tick'), ms: fc.integer({ min: 1, max: 5_000 }) }),
);

/** Valeur et horloge d'un champ dans une base. */
async function fieldState(device: SimDevice, task: TaskId, field: string): Promise<{ value: unknown; hlc: string }> {
  const rows = await device.driver.select<{ v: string | number | null; hlc: string }>(
    `SELECT ${field} AS v, COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = t.id AND field = ?), (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = t.id AND field = '*'), t.hlc) AS hlc FROM task t WHERE id = ?`,
    [field, task],
  );
  return { value: rows[0]?.v, hlc: rows[0]?.hlc ?? '' };
}

describe('propriétés du moteur à deux appareils (fast-check)', () => {
  it('convergence et aucune perte, quels que soient l’ordre des recopies, des cycles et des écritures hors ligne', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 4, maxLength: 18 }), async (steps) => {
        const a = await createSimDevice(IDS[0]);
        const b = await createSimDevice(IDS[1], { clock: a.clock });
        const devices = [a, b];
        TASKS_DYNAMIC.length = 0;
        try {
          await setupFirst(a);
          for (const id of TASKS) await a.createTask('Initiale', { id });
          await a.cycle();
          await pair(a, b);
          await b.cycle();
          syncFolders(devices);
          await a.cycle();
          // Toutes les écritures, avec leur hlc de champ : la valeur finale doit être celle du plus grand.
          const writes: { task: TaskId; field: string; value: unknown; hlc: string }[] = [];
          const all = [...TASKS];
          let created = 0;
          for (const step of steps) {
            if (step.kind === 'tick') {
              a.clock.advance(step.ms);
            } else if (step.kind === 'cycle') {
              await devices[step.device]?.cycle();
            } else if (step.kind === 'create') {
              // Création hors ligne puis éventuelles modifications avant publication (ligne publiée en plusieurs opérations).
              const d = devices[step.device] as SimDevice;
              created += 1;
              const id = `20000000-0000-4000-8000-${String(created).padStart(12, '0')}` as TaskId;
              await d.createTask(step.value, { id });
              all.push(id);
              TASKS_DYNAMIC.push(id);
            } else if (step.kind === 'propagate') {
              const from = devices[step.from] as SimDevice;
              propagate(from.folder, (devices[1 - step.from] as SimDevice).folder, from.id);
            } else {
              const d = devices[step.device] as SimDevice;
              const pool = [...TASKS, ...TASKS_DYNAMIC];
              const task = pool[(step.task + TASKS_DYNAMIC.length) % pool.length] as TaskId;
              const current = await d.task(task);
              if (!current) continue;
              if (step.kind === 'title' || step.kind === 'note') {
                if (current.deletedAt !== null) continue;
                await d.updateTask(task, { [step.kind]: step.value });
                writes.push({ task, field: step.kind, ...(await fieldState(d, task, step.kind)) });
              } else if (step.kind === 'delete' && current.deletedAt === null) {
                await d.deleteTask(task);
                writes.push({ task, field: 'deleted_at', ...(await fieldState(d, task, 'deleted_at')) });
              } else if (step.kind === 'restore' && current.deletedAt !== null) {
                await d.data.repos.tasks.restore([task]);
                writes.push({ task, field: 'deleted_at', ...(await fieldState(d, task, 'deleted_at')) });
              }
            }
          }
          for (let i = 0; i < 2; i += 1) {
            await a.cycle();
            await b.cycle();
            syncFolders(devices);
          }
          await a.cycle();
          await b.cycle();
          for (const task of all) {
            for (const field of ['title', 'note', 'deleted_at']) {
              const onA = await fieldState(a, task, field);
              const onB = await fieldState(b, task, field);
              expect(onB).toEqual(onA);
              const last = writes.filter((w) => w.task === task && w.field === field).sort((x, y) => (x.hlc < y.hlc ? -1 : 1)).at(-1);
              if (last) {
                expect(onA.hlc).toBe(last.hlc);
                expect(onA.value).toEqual(last.value);
              }
            }
          }
        } finally {
          await Promise.all(devices.map((d) => d.close()));
        }
      }),
      { numRuns: 15 },
    );
  }, 300_000);
});
