import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNetworkStatus, useAppStatusStore } from './appStatus';
import { AppStatusBanner } from './AppStatusBanner';

const set = useAppStatusStore.getState().setStatus;
const KINDS = ['offline', 'syncing', 'waitingIcloud', 'calendarDisconnected', 'syncTrouble', 'updateRequired', 'signingExpiry'] as const;

describe('bandeau d’état de l’app (A-09)', () => {
  afterEach(() => {
    cleanup();
    for (const kind of KINDS) set(kind, null);
    vi.restoreAllMocks();
  });

  it('aucun état : aucun bandeau', () => {
    render(<AppStatusBanner />);
    expect(document.querySelector('.ct-status-banner')).toBeNull();
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
      expect(document.querySelector('.ct-status-banner')).toHaveTextContent(text);
    }
  });

  it('I-02 (M0) : « signingExpiry » passe devant tous les autres états ; texte générique selon detail, ou message composé', () => {
    render(<AppStatusBanner />);
    act(() => {
      set('calendarDisconnected', { detail: 'Perso' });
      set('signingExpiry', { detail: 'soon' });
    });
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('CircleTasks expire bientôt : actualisez-la dans SideStore');
    act(() => set('signingExpiry', { detail: 'expired' }));
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('La signature est expirée : réinstallez l’app');
    act(() => set('signingExpiry', { detail: 'soon', message: 'CircleTasks expire dans 5 h' }));
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('CircleTasks expire dans 5 h');
    act(() => set('signingExpiry', null));
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Agenda Perso déconnecté');
  });

  it('revue point 5 : la région est toujours montée, polie et atomique', () => {
    render(<AppStatusBanner />);
    const region = screen.getByTestId('status-banner-region');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveAttribute('aria-atomic', 'true');
    act(() => set('offline', {}));
    expect(screen.getByTestId('status-banner-region')).toBe(region);
  });

  it('revue point 3 : « Synchro en cours » reste visible mais hors de la région vivante (non annoncé) ; « Hors ligne » et les échecs y sont annoncés', () => {
    render(<AppStatusBanner />);
    const region = screen.getByTestId('status-banner-region');
    act(() => set('syncing', {}));
    expect(screen.getByText('Synchro en cours')).toBeVisible();
    expect(region).not.toContainElement(screen.getByText('Synchro en cours'));
    act(() => set('syncTrouble', { message: 'Échec' }));
    expect(region).toHaveTextContent('Échec');
    act(() => set('syncTrouble', null));
    expect(region).toBeEmptyDOMElement();
    act(() => set('offline', {}));
    act(() => set('syncing', null));
    expect(region).toHaveTextContent('Hors ligne');
  });

  it('seconde revue point C : offline, syncing, offline ne change pas le contenu de la région (« Hors ligne » non réannoncé)', () => {
    render(<AppStatusBanner />);
    const region = screen.getByTestId('status-banner-region');
    act(() => set('offline', {}));
    expect(region).toHaveTextContent('Hors ligne');
    const seen: string[] = [];
    const observer = new MutationObserver((records) => seen.push(...records.map((r) => r.type)));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    act(() => set('syncing', {}));
    expect(region).toHaveTextContent('Hors ligne');
    expect(screen.getByText('Synchro en cours')).toBeVisible();
    act(() => set('syncing', null));
    seen.push(...observer.takeRecords().map((r) => r.type));
    observer.disconnect();
    expect(seen).toEqual([]);
    expect(region).toHaveTextContent('Hors ligne');
  });

  it('troisième revue point 2 : data-visually-empty présent sans bandeau visible dans la région (aucun état, hors ligne + synchro), absent avec un bandeau visible', () => {
    render(<AppStatusBanner />);
    const region = screen.getByTestId('status-banner-region');
    expect(region).toHaveAttribute('data-visually-empty');
    act(() => set('offline', {}));
    expect(region).not.toHaveAttribute('data-visually-empty');
    act(() => set('syncing', {}));
    expect(region).toHaveTextContent('Hors ligne');
    expect(region).toHaveAttribute('data-visually-empty');
    act(() => set('syncing', null));
    expect(region).not.toHaveAttribute('data-visually-empty');
    act(() => set('offline', null));
    expect(region).toHaveAttribute('data-visually-empty');
  });

  it('troisième revue point 4 : hors ligne + synchro, puis un échec survient : la région passe au texte de l’échec', () => {
    render(<AppStatusBanner />);
    const region = screen.getByTestId('status-banner-region');
    act(() => {
      set('offline', {});
      set('syncing', {});
    });
    expect(region).toHaveTextContent('Hors ligne');
    act(() => set('syncTrouble', { message: 'Échec de synchro' }));
    expect(region).toHaveTextContent('Échec de synchro');
    expect(region).not.toHaveTextContent('Hors ligne');
    expect(region).not.toHaveAttribute('data-visually-empty');
    expect(document.querySelectorAll('.ct-status-banner')).toHaveLength(1);
  });

  it('un seul bandeau, le plus prioritaire (critère 5)', () => {
    render(<AppStatusBanner />);
    act(() => {
      set('offline', {});
      set('syncing', {});
    });
    expect(document.querySelectorAll('.ct-status-banner:not(.ct-visually-hidden)')).toHaveLength(1);
    expect(document.querySelector('.ct-status-banner:not(.ct-visually-hidden)')).toHaveTextContent('Synchro en cours');
    act(() => set('calendarDisconnected', { detail: 'Perso', onAction: () => undefined }));
    expect(document.querySelector('.ct-status-banner:not(.ct-visually-hidden)')).toHaveTextContent('Agenda Perso déconnecté');
    act(() => set('calendarDisconnected', null));
    expect(document.querySelector('.ct-status-banner:not(.ct-visually-hidden)')).toHaveTextContent('Synchro en cours');
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
    expect(document.querySelector('.ct-status-banner')).toBeNull();
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Hors ligne');
    act(() => void window.dispatchEvent(new Event('online')));
    expect(document.querySelector('.ct-status-banner')).toBeNull();
    stop();
  });

  it('démarrer hors ligne affiche le bandeau tout de suite ; l’arrêt le retire', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<AppStatusBanner />);
    let stop = (): void => undefined;
    act(() => {
      stop = startNetworkStatus();
    });
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Hors ligne');
    act(() => stop());
    expect(document.querySelector('.ct-status-banner')).toBeNull();
  });

  it('problème de synchro : texte de la source, « Voir » qui appelle son action, role="status" (critères 9 a, 9 c, 9 h)', () => {
    const onAction = vi.fn();
    render(<AppStatusBanner />);
    act(() => set('syncTrouble', { detail: 'key-mismatch', message: 'Ce dossier a été chiffré avec une autre clé : associez cet appareil', more: 0, onAction }));
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Ce dossier a été chiffré avec une autre clé : associez cet appareil');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Voir le problème de synchronisation' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('problème de synchro : « (+N) » quand d’autres états attendent ; texte seul sans action', () => {
    render(<AppStatusBanner />);
    act(() => set('syncTrouble', { detail: 'error', message: 'La synchronisation a échoué', more: 2 }));
    expect(document.querySelector('.ct-status-banner')?.textContent).toBe('La synchronisation a échoué (+2)');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('« Hors ligne » ne masque jamais un problème de synchro (critère 9 a)', () => {
    render(<AppStatusBanner />);
    act(() => {
      set('offline', {});
      set('syncing', {});
      set('syncTrouble', { detail: 'error', message: 'Échec' });
    });
    expect(document.querySelectorAll('.ct-status-banner')).toHaveLength(1);
    expect(document.querySelector('.ct-status-banner')).toHaveTextContent('Échec');
  });

  it('« En attente d’iCloud » : cause de la source si elle est donnée, sinon texte générique (critère 9 e)', () => {
    render(<AppStatusBanner />);
    act(() => set('waitingIcloud', { message: 'Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour' }));
    expect(document.querySelector('.ct-status-banner')?.textContent).toBe('Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour');
    act(() => set('waitingIcloud', {}));
    expect(document.querySelector('.ct-status-banner')?.textContent).toBe('En attente d’iCloud');
  });
});
