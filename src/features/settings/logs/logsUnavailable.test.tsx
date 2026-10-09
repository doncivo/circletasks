import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../domain/clock';
import { createHlcClock } from '../../../domain/hlc';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { currentLogJournal } from '../../../platform/desktop/log';
import { createMemoryFiles } from '../../../platform/files';
import { AppContainerProvider } from '../../app/AppContainerContext';
import { createAppContainer } from '../../app/container';
import { LogsScreen } from './LogsScreen';
import { LOG_JOURNAL_WAIT_MS } from './useLogJournal';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fc');

/**
 * Audit du lot F (aucune impasse) : journal jamais installé -> après l'attente, « Journal indisponible » avec le code et « Réessayer », qui
 * relance réellement le chargement et affiche la liste ; plateforme sans enregistrement : « Exporter » absent, la raison est dite.
 */
describe('I-04 : écran Logs sans journal installé', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('jamais bloqué sur « Lecture du journal… » : indisponible (code) puis « Réessayer » qui installe le journal', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const clock = createManualClock('2026-10-08T08:00:00.000Z');
    const container = createAppContainer({ clock, hlc: createHlcClock({ clock, deviceId: DEVICE }), data: {} as never, files: createMemoryFiles({ canSave: false }), platform: { runtime: 'web', os: 'ios' } });
    render(
      <AppContainerProvider container={container}>
        <LogsScreen />
      </AppContainerProvider>,
    );
    expect(screen.getByText('Lecture du journal…')).toBeInTheDocument();
    expect(screen.getByText(/L’export n’est pas disponible sur cette plateforme/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exporter' })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_JOURNAL_WAIT_MS);
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Journal indisponible. Code : not-installed');
    expect(screen.queryByText('Lecture du journal…')).toBeNull();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText('Aucune entrée', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(currentLogJournal()).not.toBeNull();
    expect(screen.queryByText(/Journal indisponible/)).toBeNull();
  });
});
