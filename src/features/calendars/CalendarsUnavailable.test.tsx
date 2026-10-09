import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppContainerProvider } from '../app/AppContainerContext';
import { appReload } from '../security/lockLayer';
import { mockViewport } from '../today/testKit';
import { CalendarsScreen } from './CalendarsScreen';
import { calendarsStore } from './calendarsStore';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

let h: CalendarHarness;
beforeEach(async () => {
  mockViewport(440);
  h = await setupCalendarHarness('13');
});
afterEach(() => h.close());

describe('compte « Indisponible » : un geste utile (revue : aucune impasse)', () => {
  it('« Relancer » relance l’app quand le fournisseur n’a pas pu être chargé', async () => {
    const reload = vi.spyOn(appReload, 'run').mockImplementation(() => undefined);
    const store = calendarsStore.get(h.container);
    expect(await store.getState().connectGoogle()).toMatchObject({ ok: true });
    const id = store.getState().accounts[0]?.id;
    if (id === undefined) throw new Error('compte absent');
    store.setState({ states: { ...store.getState().states, [id]: { kind: 'error', lastSuccessAt: null, error: 'unavailable', retryAt: null } } });
    render(
      <AppContainerProvider container={h.container}>
        <CalendarsScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Indisponible : rouvrez l’app')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Relancer l’app pour recharger/ }));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  });
});
