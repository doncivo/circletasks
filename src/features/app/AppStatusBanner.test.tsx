import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNetworkStatus, useAppStatusStore } from './appStatus';
import { AppStatusBanner } from './AppStatusBanner';

const set = useAppStatusStore.getState().setStatus;
const KINDS = ['offline', 'syncing', 'waitingIcloud', 'calendarDisconnected', 'syncTrouble', 'updateRequired'] as const;

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

  it('problème de synchro : texte de la source, « Voir » qui appelle son action, role="status" (critères 9 a, 9 c, 9 h)', () => {
    const onAction = vi.fn();
    render(<AppStatusBanner />);
    act(() => set('syncTrouble', { detail: 'key-mismatch', message: 'Ce dossier a été chiffré avec une autre clé : associez cet appareil', more: 0, onAction }));
    expect(screen.getByRole('status')).toHaveTextContent('Ce dossier a été chiffré avec une autre clé : associez cet appareil');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('problème de synchro : « (+N) » quand d’autres états attendent ; texte seul sans action', () => {
    render(<AppStatusBanner />);
    act(() => set('syncTrouble', { detail: 'error', message: 'La synchronisation a échoué', more: 2 }));
    expect(screen.getByRole('status').textContent).toBe('La synchronisation a échoué (+2)');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('« Hors ligne » ne masque jamais un problème de synchro (critère 9 a)', () => {
    render(<AppStatusBanner />);
    act(() => {
      set('offline', {});
      set('syncing', {});
      set('syncTrouble', { detail: 'error', message: 'Échec' });
    });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('Échec');
  });

  it('« En attente d’iCloud » : cause de la source si elle est donnée, sinon texte générique (critère 9 e)', () => {
    render(<AppStatusBanner />);
    act(() => set('waitingIcloud', { message: 'Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour' }));
    expect(screen.getByRole('status').textContent).toBe('Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour');
    act(() => set('waitingIcloud', {}));
    expect(screen.getByRole('status').textContent).toBe('En attente d’iCloud');
  });
});
