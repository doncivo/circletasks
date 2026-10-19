import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { DEDUP_FAILURES_META } from '../../domain/occurrenceDedup';
import { asEntityId, type DeviceId } from '../../domain/types';
import { tCarry } from '../../i18n/syncCarryReportText';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer } from '../app/container';
import { SyncDetailsDedup } from './SyncDetailsDedup';

/** T-TECH-01 I4 : la ligne des Détails de la synchro apparaît au troisième échec de suite du nettoyage, pas avant. */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d8');
let db: TestDb;
beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-18T08:00:00.000Z');
});
afterEach(async () => {
  cleanup();
  await db.close();
});

const show = async () => {
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<AppContainerProvider container={container}><SyncDetailsDedup /></AppContainerProvider>);
    await db.data.repos.sync.getMeta(DEDUP_FAILURES_META);
  });
  return view;
};

describe('ligne « nettoyage en échec » des Détails de la synchro (T-TECH-01 I4)', () => {
  it('deux échecs : rien ; trois échecs : la ligne est visible', async () => {
    await db.data.repos.sync.setMeta(DEDUP_FAILURES_META, '2');
    const two = await show();
    expect(screen.queryByText(tCarry('dedupFailed'))).toBeNull();
    two.unmount();
    await db.data.repos.sync.setMeta(DEDUP_FAILURES_META, '3');
    await show();
    expect(screen.getByRole('status').textContent).toBe(tCarry('dedupFailed'));
  });
});
