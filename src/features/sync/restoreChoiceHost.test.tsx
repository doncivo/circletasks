import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { tRestore } from '../../i18n/syncRestoreText';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { RestoreChoiceHost } from './RestoreChoiceHost';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * Y-FIX-04 (décision d'Ali du 2026-10-18, option 2) : la fenêtre de choix après restauration est un bloc à la demande. Hors de la phase
 * `restore-choice` (et sans choix rouvert), l'hôte ne rend rien ; la phase apparaît : la fenêtre est chargée puis s'ouvre d'elle-même avec
 * ses textes (catalogue à part). Attentes par `findBy…` (mutation du DOM, aucun délai réel).
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d1');
const NOW = '2026-10-05T08:02:00.000Z';

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  await db.close();
});

describe('fenêtre de choix après restauration chargée à la demande (Y-FIX-04)', () => {
  it('rien hors de restore-choice ; la phase apparaît : la fenêtre se charge et s’ouvre avec ses textes', async () => {
    render(
      <AppContainerProvider container={container}>
        <RestoreChoiceHost />
      </AppContainerProvider>,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    sync.restore = { marker: { backup: 'x', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 17 }, options: ['apply-everywhere', 'keep-synced'] };
    act(() => {
      sync.setStatus({ phase: 'restore-choice' });
    });
    await screen.findByRole('alertdialog');
    expect(screen.getByText(tRestore('title'))).toBeTruthy();
    expect(screen.getByRole('button', { name: tRestore('applyEverywhere') })).toBeTruthy();
    expect(screen.getByRole('button', { name: tRestore('keepSynced') })).toBeTruthy();
  });
});
