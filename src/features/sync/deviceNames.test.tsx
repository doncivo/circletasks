import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { syncStore } from './syncStore';
import { deviceName } from './syncText';
import { createFakeSyncService } from './testKit';

const SELF = '60000000-0000-4000-8000-000000000d61' as DeviceId;
const OTHER = '70000000-0000-4000-8000-000000000d62' as DeviceId;
let db: TestDb;
let container: AppContainer;
const devices = [
  { deviceId: SELF, platform: 'windows' as const, self: true, lastReadAt: null, status: 'active' as const },
  { deviceId: OTHER, platform: 'windows' as const, self: false, lastReadAt: null, status: 'forgotten' as const },
];
const makeContainer = () => createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync: createFakeSyncService({ phase: 'idle', devices }) });
beforeEach(async () => { db = await openTestDb(SELF, '2026-10-24T10:00:00Z'); container = makeContainer(); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await db.close(); });

describe('UI-FIX-02 : noms locaux d’appareils', () => {
  it('une préférence illisible est signalée, bloque le renommage puis peut être relue sans écrasement', async () => {
    await container.data.repos.sync.setMeta('ui.deviceNames', '{incomplete');
    render(<AppContainerProvider container={container}><SyncDetailsScreen /></AppContainerProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de lire les noms enregistrés');
    expect(screen.getByRole('button', { name: 'Renommer PC 2' })).toBeDisabled();
    expect(await container.data.repos.sync.getMeta('ui.deviceNames')).toBe('{incomplete');
    await container.data.repos.sync.setMeta('ui.deviceNames', '{}');
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    const store = syncStore.get(container);
    await store.getState().loadDeviceNames();
    expect(store.getState().deviceNameError).toBeNull();
  });
  it('noms lisibles par défaut, sans fragment d’identifiant', () => {
    expect(devices.map((device) => deviceName(device, devices))).toEqual(['PC 1', 'PC 2']);
  });
  it('renomme, persiste et relit le nom après recréation du conteneur', async () => {
    render(<AppContainerProvider container={container}><SyncDetailsScreen /></AppContainerProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Renommer PC 2' }));
    const field = screen.getByRole('textbox', { name: 'Nom de l’appareil' });
    fireEvent.change(field, { target: { value: 'Ancien PC du bureau' } });
    const form = field.closest('form');
    if (!form) throw new Error('formulaire de nom absent');
    fireEvent.submit(form);
    expect(await screen.findByRole('button', { name: 'Renommer Ancien PC du bureau' })).toBeInTheDocument();
    const row = document.querySelector(`[data-device-id="${OTHER}"]`); // UI-REFONTE-04 : l'identifiant complet n'est plus affiché
    if (!row) throw new Error('ligne appareil absente');
    expect(within(row).getByText('Oublié')).toBeInTheDocument();
    cleanup();
    const next = makeContainer();
    render(<AppContainerProvider container={next}><SyncDetailsScreen /></AppContainerProvider>);
    expect(await screen.findByRole('button', { name: 'Renommer Ancien PC du bureau' })).toBeInTheDocument();
  });
  it('une écriture impossible reste visible et ne prétend pas avoir changé le nom', async () => {
    const store = syncStore.get(container);
    await store.getState().loadDeviceNames();
    vi.spyOn(container.data.repos.sync, 'setMeta').mockRejectedValue(new Error('disk full'));
    expect(await store.getState().renameDevice(OTHER, 'PC du salon')).toBe(false);
    expect(store.getState().deviceNameError).toBe('sync.status.nameSaveFailed');
    const other = store.getState().status.devices.find((device) => device.deviceId === OTHER);
    if (!other) throw new Error('appareil absent');
    expect(deviceName(other, store.getState().status.devices)).toBe('PC 2');
  });
});
