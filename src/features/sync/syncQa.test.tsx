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
import { BackupSheet } from '../settings/BackupSheet';
import { trashStore } from '../tasks/trashStore';
import { createMemoryBackup } from '../../platform/backup';
import { applyRemoteChanges } from './remoteChanges';
import { SyncStatusLine } from './SyncStatusLine';
import { createFakeSyncService, nextChange, type FakeSyncService } from './testKit';

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
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
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
    const text = screen.getByTestId('sync-status-text').textContent ?? '';
    expect(text.length).toBeGreaterThan(3);
    expect(text).not.toMatch(/undefined|\{|\}/);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('accessibilité du bouton (Y-03 critère 8)', () => {
  it('bouton natif, atteignable au clavier (Tab, Entrée, Espace activent un bouton natif), état annoncé par une région vivante séparée', () => {
    renderLine();
    const button = screen.getByRole('button', { name: 'Synchroniser' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('tabindex')).not.toBe('-1');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(screen.getByTestId('sync-status-live')).toBeTruthy();
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

describe('feuille de sauvegarde (Y-02 critère 13)', () => {
  const sheet = (c: AppContainer) =>
    render(
      <AppContainerProvider container={c}>
        <BackupSheet onClose={() => undefined} />
      </AppContainerProvider>,
    );

  it('dossier configuré : « Cet appareil est associé : le choix vous sera demandé à la prochaine synchro » ; sinon rien', async () => {
    const backups = createMemoryBackup({ versions: [], nowMs: () => db.clock.nowMs() });
    const withSync = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, backups });
    sheet(withSync);
    expect(await screen.findByText('Cet appareil est associé : le choix vous sera demandé à la prochaine synchro')).toBeTruthy();
    cleanup();
    sync.setStatus({ phase: 'not-configured' });
    const without = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync, backups });
    sheet(without);
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByText(/Cet appareil est associé/)).toBeNull();
  });
});

describe('rechargement après un lot reçu (Y-02 critère 18)', () => {
  it('la corbeille ouverte se recharge quand une tâche est touchée : une suppression reçue y apparaît', async () => {
    const task = await db.data.repos.tasks.create({
      id: asEntityId('12000000-0000-4000-8000-000000000002'), spaceId: asEntityId('00000000-0000-4000-8000-000000000001'), projectId: null, title: 'Supprimée ailleurs', note: '', date: null, time: null,
      status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, externalEventId: null,
    });
    const trash = trashStore.get(container);
    await trash.getState().load('all');
    expect(trash.getState().tasks).toEqual([]);
    await db.data.repos.tasks.softDelete([task.id]);
    // Attente : le changement du magasin de la corbeille lui-même (Y-TECH-02, aucun sondage).
    const reloaded = nextChange(trash, () => trash.getState().tasks.length > 0);
    await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set([task.id])]]) });
    await reloaded;
    expect(trash.getState().tasks.map((x) => x.id)).toEqual([task.id]);
  });

  it('corbeille jamais ouverte : aucun chargement inutile', async () => {
    const trash = trashStore.get(container);
    await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set(['12000000-0000-4000-8000-000000000003'])]]) });
    expect(trash.getState().status).toBe('idle');
  });
});
