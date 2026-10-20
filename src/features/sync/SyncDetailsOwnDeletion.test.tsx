import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { DeviceId, IsoDateTime } from '../../domain/types';
import type { EpochId } from '../../domain/sync/format';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { syncOwnDeletionFr } from '../../i18n/fr.syncOwnDeletion';
import { syncOwnDeletionEn } from '../../i18n/en.syncOwnDeletion';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { createFakeSyncService, type FakeSyncService } from './testKit';
import { SyncDetailsOwnDeletion } from './SyncDetailsOwnDeletion';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { syncStore } from './syncStore';

const SELF = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const EPOCH = `e0001-${SELF}` as EpochId;
let db: TestDb;
let sync: FakeSyncService;
let container: AppContainer;
beforeEach(async () => {
  db = await openTestDb(SELF, '2026-10-19T08:00:00.000Z');
  sync = createFakeSyncService({ phase: 'idle', ownDelete: [{ epoch: EPOCH, kind: 'epoch', orphan: true, code: 'io', at: '2026-10-19T08:00:00.000Z' as IsoDateTime }] });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});
afterEach(async () => { cleanup(); await db.close(); });

describe('Détails : échec de suppression propre', () => {
  it('montre cause, heure 24 h et dossier ; la ligne disparaît seulement avec la résolution', () => {
    render(<AppContainerProvider container={container}><SyncDetailsOwnDeletion /></AppContainerProvider>);
    expect(screen.getByRole('status').textContent).toContain("Les fichiers de l'ancienne époque");
    expect(screen.getByRole('status').textContent).toMatch(/Dernier essai à \d{2}:\d{2}/);
    expect(screen.getByRole('status').textContent).toContain(`CircleTasks › devices › ef50b6f7 › ${EPOCH}`);
    expect(screen.getByRole('status').textContent).not.toContain(' : io');
    act(() => sync.setStatus({ ownDelete: [] }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('Réessayer lance un cycle manuel, désactive le bouton et garde la cause pendant le cycle', async () => {
    sync.hold = true;
    render(<AppContainerProvider container={container}><SyncDetailsOwnDeletion /></AppContainerProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer maintenant' }));
    expect(sync.calls).toEqual(['manual']);
    const button = screen.getByRole('button', { name: 'Réessayer maintenant' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status')).toBeTruthy();
    const store = syncStore.get(container);
    const settled = new Promise<void>((resolve) => {
      const stop = store.subscribe((s) => { if (!s.busy) { stop(); resolve(); } });
    });
    await act(async () => { sync.release(); await settled; });
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('les catalogues fr/en ont les mêmes clés et paramètres', () => {
    expect(Object.keys(syncOwnDeletionFr).sort()).toEqual(Object.keys(syncOwnDeletionEn).sort());
    for (const key of Object.keys(syncOwnDeletionFr) as (keyof typeof syncOwnDeletionFr)[]) {
      expect(syncOwnDeletionFr[key].match(/\{\w+\}/g) ?? []).toEqual(syncOwnDeletionEn[key].match(/\{\w+\}/g) ?? []);
    }
  });

  it('la cause reste au-dessus de la publication bloquée dans le même écran', async () => {
    sync.setStatus({ warnings: ['own-delete-failed', 'publish-blocked'] });
    await act(async () => {
      render(<AppContainerProvider container={container}><SyncDetailsScreen slots={{ pairing: null, conflicts: null, version: null, forget: null, reset: null, carryReport: null }} /></AppContainerProvider>);
      await import('./SyncDetailsOwnDeletion');
    });
    const cause = document.querySelector('.ct-sync__ownDeletion') as HTMLElement;
    const blocked = document.querySelector('[data-warning="publish-blocked"]') as HTMLElement;
    expect(cause).not.toBeNull();
    expect(blocked).not.toBeNull();
    expect(cause.compareDocumentPosition(blocked) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
