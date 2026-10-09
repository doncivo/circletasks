import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../../domain/hlc';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { openTestDb, type TestDb } from '../../../db/repositories/sql/testSetup';
import { currentLogJournal, installLogJournal, logFailure, whenLogJournal } from '../../../platform/desktop/log';
import { createLogJournal, createMemoryLogTransport } from '../../../platform/logs';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { createAppContainer } from '../../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../../app/navigation';
import { AboutSection } from '../AboutSection';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fa');

/**
 * I-04 critères 1, 3 et 10 : `logFailure` est le seul entonnoir (entrées notées avant l'installation versées au journal), ligne « Version … »
 * avec le lien « Logs » (iPhone et PC), échec du journal signalé en rouge sur la ligne.
 */
describe('I-04 : entonnoir logFailure et ligne « Logs » de Réglages', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-08T08:00:00.000Z');
  });
  afterEach(async () => {
    await db.close();
    cleanup();
    vi.restoreAllMocks();
    useNavigationStore.setState(INITIAL_NAVIGATION);
  });

  const transport = createMemoryLogTransport();
  const journal = createLogJournal(transport, { document: null, window: null });

  it('critère 3 : avant l’installation, les entrées attendent ; installées, elles vont au journal puis au fichier', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(currentLogJournal()).toBeNull();
    logFailure('sync', 'sync-now {"reason":"open"}');
    logFailure('backup-daily', new Error('sauvegarde : io'));
    installLogJournal(journal);
    expect(await whenLogJournal()).toBe(journal);
    logFailure('export-save', { code: 'unsafe-folder', message: 'refusé' });
    await journal.flush();
    expect(transport.stored.map((entry) => [entry.scope, entry.code])).toEqual([
      ['sync', 'sync-now'],
      ['backup-daily', 'sauvegarde'],
      ['export-save', 'unsafe-folder'],
    ]);
  });

  function renderAbout(os: 'ios' | 'windows') {
    const clock = db.clock;
    const desktop = os === 'windows' ? ({ getVersion: () => Promise.resolve('0.2.0') } as never) : null;
    const appVersion = os === 'windows' ? { appVersion: { ok: true, version: '0.2.0', source: 'runtime' } as const } : {};
    const container = createAppContainer({ clock, hlc: createHlcClock({ clock, deviceId: DEVICE }), data: db.data, desktop, platform: { runtime: 'web', os }, ...appVersion });
    return render(
      <AppContainerProvider container={container}>
        <AboutSection />
      </AppContainerProvider>,
    );
  }

  it('critère 1 : iPhone et PC, la ligne « Version … » porte le lien « Logs », qui ouvre l’écran', async () => {
    renderAbout('ios');
    // I-06 : la version vient du conteneur (lue au démarrage, platform/appVersion.ts) ; sans lecture, la constante de build (tauri.conf.json).
    expect(await screen.findByText(`Version ${__CT_APP_VERSION__}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ouvrir l’écran des logs' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'logs' });
    cleanup();
    renderAbout('windows');
    expect(await screen.findByText('Version 0.2.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ouvrir l’écran des logs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rechercher une mise à jour' })).toBeInTheDocument();
  });

  it('critère 10 : un échec d’écriture du journal est signalé en rouge sur la ligne, puis disparaît à la prochaine écriture réussie', async () => {
    renderAbout('ios');
    transport.failAppend('disk-full');
    await act(async () => {
      journal.record('sync', 'x');
      await journal.flush();
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Le journal n’a pas pu être écrit. Code : disk-full');
    expect(alert.className).toContain('ct-settings__hint--missed');
    transport.failAppend(null);
    await act(async () => {
      await journal.flush();
    });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});
