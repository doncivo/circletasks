import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNetworkStatus, useAppStatusStore } from './appStatus';
import { AppStatusBanner } from './AppStatusBanner';

const set = useAppStatusStore.getState().setStatus;
const KINDS = ['offline', 'syncing', 'waitingIcloud', 'calendarDisconnected'] as const;

describe('bandeau d’état de l’app (A-09)', () => {
  afterEach(() => {
    cleanup();
    for (const kind of KINDS) set(kind, null);
    vi.restoreAllMocks();
  });

  it('aucun état : aucun bandeau', () => {
    render(<AppStatusBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('les textes des quatre états existent (critère 6)', () => {
    render(<AppStatusBanner />);
    const cases = [
      ['offline', {}, 'Hors ligne'],
      ['syncing', {}, 'Synchro en cours'],
      ['waitingIcloud', {}, 'En attente d’iCloud'],
      ['calendarDisconnected', { detail: 'Google Agenda' }, 'Agenda Google Agenda déconnecté'],
    ] as const;
    for (const [kind, source, text] of cases) {
      for (const other of KINDS) set(other, null);
      act(() => set(kind, source));
      expect(screen.getByRole('status')).toHaveTextContent(text);
    }
  });

  it('un seul bandeau, le plus prioritaire (critère 5)', () => {
    render(<AppStatusBanner />);
    act(() => {
      set('offline', {});
      set('syncing', {});
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Synchro en cours');
    act(() => set('calendarDisconnected', { detail: 'Perso', onAction: () => undefined }));
    expect(screen.getByRole('status')).toHaveTextContent('Agenda Perso déconnecté');
    act(() => set('calendarDisconnected', null));
    expect(screen.getByRole('status')).toHaveTextContent('Synchro en cours');
  });

  it('l’alerte d’agenda propose « Reconnecter » qui appelle l’action de sa source (critère 6)', () => {
    const onAction = vi.fn();
    render(<AppStatusBanner />);
    act(() => set('calendarDisconnected', { detail: 'Google', onAction }));
    fireEvent.click(screen.getByRole('button', { name: 'Reconnecter' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('réseau : « Hors ligne » quand l’appareil perd le réseau, retiré au retour (critères 3, 4)', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const stop = startNetworkStatus();
    render(<AppStatusBanner />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(screen.getByRole('status')).toHaveTextContent('Hors ligne');
    act(() => void window.dispatchEvent(new Event('online')));
    expect(screen.queryByRole('status')).toBeNull();
    stop();
  });

  it('démarrer hors ligne affiche le bandeau tout de suite ; l’arrêt le retire', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<AppStatusBanner />);
    let stop = (): void => undefined;
    act(() => {
      stop = startNetworkStatus();
    });
    expect(screen.getByRole('status')).toHaveTextContent('Hors ligne');
    act(() => stop());
    expect(screen.queryByRole('status')).toBeNull();
  });
});
