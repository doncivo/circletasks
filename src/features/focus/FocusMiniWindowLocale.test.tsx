import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { getLocale, setLocale } from '../../i18n';
import { createFakeSoundPlayer, type FocusWindowClient, type FocusWindowState } from '../../platform/focus';
import { FocusMiniWindow } from './FocusMiniWindow';

const START = '2026-10-04T08:00:00.000Z';
const state = (title: string, locale: 'fr' | 'en'): FocusWindowState => ({
  phase: 'running',
  session: { id: 's1', plannedMin: 25, startedAt: START, endedAt: null, pausedSec: 0, pausedAt: null },
  title,
  time: '09:00',
  spaceName: 'Pro',
  canFinishTask: true,
  today: { minutes: 0, sessions: 0 },
  sound: { enabled: false, nonce: 0 },
  endedMinutes: 0,
  locale,
});

/** PERF-02 : un changement de langue en retard (catalogue chargé à la demande) ne remplace jamais un état plus récent. */
describe('mini-fenêtre Focus : états et langue', () => {
  afterEach(() => setLocale('fr'));

  function mount() {
    let push: (next: FocusWindowState) => void = () => undefined;
    const client: FocusWindowClient = {
      onState: (handler) => {
        push = handler;
        return Promise.resolve(() => undefined);
      },
      send: () => Promise.resolve(),
      onCloseRequested: () => Promise.resolve(() => undefined),
      onMoved: () => Promise.resolve(() => undefined),
    } as FocusWindowClient;
    render(<FocusMiniWindow client={client} clock={createManualClock(Date.parse('2026-10-04T08:05:00.000Z'))} player={createFakeSoundPlayer()} />);
    return (next: FocusWindowState) => act(() => push(next));
  }

  it('l’état s’affiche tout de suite, même si sa langue est à charger', async () => {
    const publish = mount();
    await waitFor(() => undefined);
    publish(state('Écrire le devis', 'en'));
    expect(await screen.findByText('Écrire le devis')).toBeInTheDocument();
    await waitFor(() => expect(getLocale()).toBe('en'));
  });

  it('un état ancien en anglais ne repasse pas par-dessus un état récent en français', async () => {
    const publish = mount();
    await waitFor(() => undefined);
    publish(state('Ancien', 'en'));
    publish(state('Récent', 'fr'));
    expect(await screen.findByText('Récent')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getLocale()).toBe('fr');
    expect(screen.queryByText('Ancien')).toBeNull();
  });
});
