// Y-TECH-05 contre-revue 7 : une lecture du bandeau lancée avant « J'ai vu » et terminée après ne repose jamais l'ancienne ligne.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createAppContainer, type AppContainer } from '../app/container';
import { loadCarryLine, refreshCarryLine } from './carryReportBannerLine';
import { carryLines } from './syncRestoreState';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f5');
const NOW = '2026-10-18T08:02:00.000Z' as IsoDateTime;

let db: TestDb;
let container: AppContainer;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.close();
});

async function seed(epoch: string): Promise<number> {
  const reports = await db.data.repos.carryReports();
  const id = await reports.create({ epoch, cause: 'restore', reporter: SELF, opener: SELF, mode: 'replace', createdAt: NOW });
  await reports.save(
    id,
    { authors: [], restored: [{ table: 'task', rowId: 'r', label: 'A', by: SELF, deletedAt: NOW, deletedBy: SELF }], recreated: [], parentReplaced: [], overflow: 0, overflowBy: { restored: 0, recreated: 0, parentReplaced: 0 } },
    true,
  );
  return id;
}

describe('course entre une lecture du bandeau et « J’ai vu » (contre-revue 7)', () => {
  it('une lecture lancée avant « J’ai vu » et terminée après ne repose pas l’ancienne ligne', async () => {
    const id = await seed('2-a');
    const real = container.data.repos.carryReports.bind(container.data.repos);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // Première lecture seulement : lit tout de suite l'état d'avant, puis attend la porte avant de le rendre.
    vi.spyOn(container.data.repos, 'carryReports').mockImplementationOnce(async () => {
      const repo = await real();
      return new Proxy(repo, {
        get: (target, key) =>
          key === 'unacknowledged'
            ? async () => {
                const stale = await target.unacknowledged();
                await gate;
                return stale;
              }
            : (Reflect.get(target, key) as unknown),
      });
    });
    const older = loadCarryLine(container);
    // Laisse la lecture ancienne atteindre la porte avant « J'ai vu ».
    await vi.waitFor(() => expect(vi.mocked(container.data.repos.carryReports)).toHaveBeenCalledTimes(1));
    await (await real()).acknowledge(id, NOW);
    await refreshCarryLine(container);
    expect(carryLines.get(container)).toBeUndefined();
    release();
    await older;
    expect(carryLines.get(container)).toBeUndefined();
  });

  it('sans course, la ligne est posée puis effacée par « J’ai vu »', async () => {
    const id = await seed('2-a');
    await loadCarryLine(container);
    expect(carryLines.get(container)?.message).toContain('éléments rétablis : 1');
    await (await db.data.repos.carryReports()).acknowledge(id, NOW);
    await refreshCarryLine(container);
    expect(carryLines.get(container)).toBeUndefined();
  });
});
