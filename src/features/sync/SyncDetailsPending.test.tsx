import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer } from '../app/container';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService } from './testKit';

afterEach(cleanup);

it('Y-FIX-05 C13 : un segment et son marqueur appareil/époque représentent un seul fichier', async () => {
  const self = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f4');
  const db = await openTestDb(self, '2026-10-19T08:00:00.000Z');
  try {
    const sync = createFakeSyncService({ phase: 'waiting-icloud', pendingFiles: ['bbbbbbbb/e0001-x/j-00000001.ctj', 'bbbbbbbb/e0001-x'] });
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: self }), data: db.data, sync });
    await act(async () => {
      render(<AppContainerProvider container={container}><SyncDetailsScreen slots={{ pairing: null, conflicts: null, version: null, forget: null, reset: null, carryReport: null }} /></AppContainerProvider>);
    });
    expect(screen.getByText(t('sync.status.pendingOne', { count: 1 }))).toBeTruthy();
    expect(screen.queryByText(t('sync.status.pendingMany', { count: 2 }))).toBeNull();
  } finally {
    cleanup();
    await db.close();
  }
});
