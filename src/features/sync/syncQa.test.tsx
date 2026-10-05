import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { DEFAULT_LOCALE, setLocale, t } from '../../i18n';
import type { SyncPhase } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { trayLabels } from '../app/desktop';
import { SyncStatusLine } from './SyncStatusLine';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * QA du lot Y2, côté écran (Y-02 critère 16, Y-03 critères 7 et 8, Y-05 critère 2) : tous les états d'erreur laissent le bouton actif
 * sans boîte bloquante, le bouton est natif et atteignable au clavier, le libellé du menu de la zone de notification suit la langue.
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000e2');
const NOW = '2026-10-05T08:00:30.000Z';

let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'iCloud Drive / CircleTasks' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  setLocale(DEFAULT_LOCALE);
  await db.close();
});

const renderLine = () =>
  render(
    <AppContainerProvider container={container}>
      <SyncStatusLine />
    </AppContainerProvider>,
  );

describe('états d’erreur (Y-03 critère 7, Y-05 critère 2)', () => {
  const cases: readonly { phase: SyncPhase; patch: Record<string, unknown> }[] = [
    { phase: 'error', patch: { errorCode: 'folder-unreachable' } },
    { phase: 'error', patch: { errorCode: 'cloud-provider-stopped' } },
    { phase: 'error', patch: { errorCode: 'io' } },
    { phase: 'waiting-icloud', patch: { errorCode: 'cloud-pending' } },
    { phase: 'key-mismatch', patch: {} },
    { phase: 'update-required', patch: {} },
    { phase: 'clock-ahead', patch: { clockAheadDevice: 'iPhone' } },
  ];
  it.each(cases)('phase $phase ($patch) : bouton actif, texte de la phase, aucune boîte bloquante', ({ phase, patch }) => {
    sync.setStatus({ phase, ...patch });
    renderLine();
    const button = screen.getByRole('button', { name: 'Synchroniser' });
    expect(button).toHaveProperty('disabled', false);
    expect(button.getAttribute('aria-busy')).not.toBe('true');
    const text = screen.getByRole('status').textContent ?? '';
    expect(text.length).toBeGreaterThan(3);
    expect(text).not.toMatch(/undefined|\{|\}/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('accessibilité du bouton (Y-03 critère 8)', () => {
  it('bouton natif, atteignable au clavier (Tab, Entrée, Espace activent un bouton natif), état annoncé par role="status"', () => {
    renderLine();
    const button = screen.getByRole('button', { name: 'Synchroniser' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('tabindex')).not.toBe('-1');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(screen.getByRole('status')).toBeTruthy();
  });
});

describe('menu de la zone de notification et langue (Y-03 critères 4 et 8)', () => {
  it('« Synchroniser maintenant » en français puis en anglais, jamais en dur', () => {
    expect(trayLabels(null, true).sync).toBe('Synchroniser maintenant');
    setLocale('en');
    const english = trayLabels(null, true).sync;
    expect(english).toBe(t('desktop.tray.sync'));
    expect(english).not.toBe('Synchroniser maintenant');
    expect(english.length).toBeGreaterThan(3);
  });
});
