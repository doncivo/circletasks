import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createFakeDesktop, type FakeDesktop } from '../../platform/desktop/testing';
import { AppContainerProvider, useAppContainer } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { toKeyInput } from '../app/shortcuts';
import { ShortcutsHelp } from './ShortcutsHelp';
import { ShortcutsSettingsSection } from './ShortcutsSettingsSection';
import { registerEscapeFallback, registerShellShortcuts } from './registerShellShortcuts';
import { quickCaptureStore } from './quickCaptureStore';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d5');
const FIELD_LABEL = 'Champ de saisie';

/** Coquille minimale : Ctrl+/ et Échap branchés comme dans App.tsx. */
function Shell({ children }: { readonly children: React.ReactNode }) {
  const container = useAppContainer();
  useEffect(() => registerEscapeFallback(container), [container]);
  useEffect(() => registerShellShortcuts(container, { help: true }), [container]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (container.shortcuts.handle(toKeyInput(event))) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [container]);
  return (
    <>
      <input aria-label={FIELD_LABEL} />
      {children}
      <ShortcutsHelp />
    </>
  );
}

describe('liste des raccourcis et réglage de la capture rapide (P-08, D-04)', () => {
  let db: TestDb;
  let desktop: FakeDesktop;
  let container: AppContainer;

  const renderShell = (children: React.ReactNode = null, c: AppContainer = container) =>
    render(
      <AppContainerProvider container={c}>
        <Shell>{children}</Shell>
      </AppContainerProvider>,
    );
  const press = (init: KeyboardEventInit, target: Element | Window = window) => fireEvent.keyDown(target, init);
  const ctrlSlash = (target: Element | Window = window) => press({ key: '/', code: 'Slash', ctrlKey: true }, target);

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    desktop = createFakeDesktop();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop });
    useNavigationStore.setState({ ...INITIAL_NAVIGATION });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    useNavigationStore.setState({ ...INITIAL_NAVIGATION });
    await db.close();
  });

  describe('fenêtre « Raccourcis clavier » (P-08)', () => {
    it('Ctrl+/ l’ouvre, même depuis un champ de saisie ; Ctrl+/ de nouveau la ferme et rend le focus (critère 1)', async () => {
      renderShell();
      const field = screen.getByLabelText('Champ de saisie');
      field.focus();
      ctrlSlash(field);
      const dialog = await screen.findByRole('dialog', { name: 'Raccourcis clavier' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      ctrlSlash(within(dialog).getByRole('searchbox', { name: 'Filtrer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(document.activeElement).toBe(field);
    });

    it('Échap et « Fermer » la ferment', async () => {
      renderShell();
      ctrlSlash();
      const dialog = await screen.findByRole('dialog', { name: 'Raccourcis clavier' });
      press({ key: 'Escape', code: 'Escape' }, dialog);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      ctrlSlash();
      fireEvent.click(await screen.findByRole('button', { name: 'Fermer' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('liste les 30 raccourcis du registre, groupés par portée, dans un tableau à en-têtes (critères 2 et 9)', async () => {
      renderShell();
      ctrlSlash();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('table', { name: 'Raccourcis clavier' })).toBeInTheDocument();
      expect(within(dialog).getAllByRole('columnheader').map((h) => h.textContent).slice(0, 2)).toEqual(['Touches', 'Action']);
      expect(within(dialog).getAllByRole('rowgroup').length).toBeGreaterThanOrEqual(4);
      for (const group of ['Global', 'Application', 'Listes', 'Semaine']) expect(within(dialog).getByText(group)).toBeInTheDocument();
      expect(dialog.querySelectorAll('[data-shortcut]')).toHaveLength(30);
      const focus = dialog.querySelector('[data-shortcut="list.focus"]');
      expect(focus?.textContent).toContain('Ctrl+Maj+F');
      expect(focus?.textContent).toContain('Contrôle plus Maj plus F');
      expect(focus?.textContent).toContain('(bientôt)');
    });

    it('affiche la combinaison de capture rapide réellement configurée (critère 3)', async () => {
      await quickCaptureStore.get(container).getState().init();
      await quickCaptureStore.get(container).getState().applyChord('Ctrl+Shift+Space');
      renderShell();
      ctrlSlash();
      const dialog = await screen.findByRole('dialog');
      expect(dialog.querySelector('[data-shortcut="global.quickCapture"]')?.textContent).toContain('Ctrl+Maj+Espace');
    });

    it('le champ « Filtrer » restreint la liste (critère 7)', async () => {
      renderShell();
      ctrlSlash();
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Filtrer' }), { target: { value: 'corbeille' } });
      expect(dialog.querySelectorAll('[data-shortcut]')).toHaveLength(1);
      expect(dialog.querySelector('[data-shortcut="list.delete"]')).not.toBeNull();
      fireEvent.change(within(dialog).getByRole('searchbox', { name: 'Filtrer' }), { target: { value: 'zzz' } });
      expect(within(dialog).getByRole('status')).toHaveTextContent('Aucun raccourci ne correspond.');
    });

    it('grise les raccourcis des listes et de la Semaine quand l’écran ne les gère pas (critère 8)', async () => {
      renderShell();
      ctrlSlash();
      const dialog = await screen.findByRole('dialog');
      expect(dialog.querySelector('[data-shortcut="list.next"]')?.textContent).toContain('(dans une liste)');
      expect(dialog.querySelector('[data-shortcut="week.next"]')?.textContent).toContain('(dans la Semaine)');
      expect(dialog.querySelector('[data-shortcut="app.newTask"]')?.textContent).not.toContain('(dans');
    });

    it('le focus reste piégé dans la fenêtre (critère 7)', async () => {
      renderShell();
      ctrlSlash();
      const dialog = await screen.findByRole('dialog');
      const close = within(dialog).getByRole('button', { name: 'Fermer' });
      close.focus();
      press({ key: 'Tab', code: 'Tab' }, document.activeElement ?? window);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  describe('Réglages › CLAVIER', () => {
    it('PC : ligne « Raccourcis clavier » qui ouvre la même fenêtre (P-08 critère 6)', async () => {
      renderShell(<ShortcutsSettingsSection />);
      expect(screen.getByText('CLAVIER')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Afficher les raccourcis clavier' }));
      expect(await screen.findByRole('dialog', { name: 'Raccourcis clavier' })).toBeInTheDocument();
    });

    it('hors application installée, pas de ligne « Capture rapide » (aucun raccourci système possible)', () => {
      renderShell(<ShortcutsSettingsSection />, createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data }));
      expect(screen.queryByText('Capture rapide')).not.toBeInTheDocument();
      expect(screen.getByText('Raccourcis clavier')).toBeInTheDocument();
    });

    const keyButton = () => screen.getByRole('button', { name: /^Capture rapide : / });

    it('affiche la combinaison, la remplace par une nouvelle et l’annonce (D-04 critères 5 et 12)', async () => {
      renderShell(<ShortcutsSettingsSection />);
      await waitFor(() => expect(keyButton()).toHaveTextContent('Ctrl+Alt+Espace'));
      fireEvent.click(keyButton());
      expect(keyButton()).toHaveTextContent('Appuyez sur la nouvelle combinaison');
      press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }, keyButton());
      expect(keyButton()).toHaveTextContent('Appuyez sur la nouvelle combinaison');
      press({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }, keyButton());
      await waitFor(() => expect(keyButton()).toHaveTextContent('Ctrl+Maj+Espace'));
      expect(desktop.globalChord).toBe('Ctrl+Shift+Space');
      expect(screen.getByRole('status')).toHaveTextContent('Capture rapide : Ctrl+Maj+Espace');
      expect(screen.getByRole('button', { name: 'Rétablir Ctrl+Alt+Espace' })).toBeInTheDocument();
    });

    it('la combinaison saisie ne déclenche aucun raccourci de l’application (Ctrl+/ pendant la capture)', async () => {
      renderShell(<ShortcutsSettingsSection />);
      await waitFor(() => expect(keyButton()).toBeInTheDocument());
      fireEvent.click(keyButton());
      press({ key: '/', code: 'Slash', ctrlKey: true }, keyButton());
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(await screen.findByRole('alert')).toHaveTextContent('Combinaison non reconnue.');
    });

    it('Échap pendant la capture l’annule sans rien changer ; le champ s’arme au clavier (critère 10)', async () => {
      renderShell(<ShortcutsSettingsSection />);
      await waitFor(() => expect(keyButton()).toBeInTheDocument());
      keyButton().focus();
      fireEvent.click(keyButton());
      press({ key: 'Escape', code: 'Escape' }, keyButton());
      await waitFor(() => expect(keyButton()).toHaveTextContent('Ctrl+Alt+Espace'));
      expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
      expect(screen.getByRole('status')).toHaveTextContent('Combinaison inchangée');
    });

    it.each([
      [{ key: 'k', code: 'KeyK', ctrlKey: true }, 'Cette combinaison est déjà utilisée dans CircleTasks.'],
      [{ key: 'k', code: 'KeyK' }, 'Ajoutez Ctrl ou Alt à la combinaison.'],
      [{ key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true }, 'La touche Windows est réservée au système.'],
    ])('refuse une combinaison invalide avec un message (critère 6) : %j', async (event, message) => {
      renderShell(<ShortcutsSettingsSection />);
      await waitFor(() => expect(keyButton()).toBeInTheDocument());
      fireEvent.click(keyButton());
      press(event, keyButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      expect(keyButton()).toHaveTextContent('Ctrl+Alt+Espace');
    });

    it('combinaison prise par une autre application : message exact, ancienne combinaison conservée (critère 7)', async () => {
      desktop.takenChords.add('Ctrl+Shift+Space');
      renderShell(<ShortcutsSettingsSection />);
      await waitFor(() => expect(keyButton()).toBeInTheDocument());
      fireEvent.click(keyButton());
      press({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true }, keyButton());
      expect(await screen.findByRole('alert')).toHaveTextContent('Combinaison déjà utilisée par une autre application');
      expect(desktop.globalChord).toBe('Ctrl+Alt+Space');
    });

    it('« Rétablir » et l’interrupteur « Désactiver » (critère 8)', async () => {
      renderShell(<ShortcutsSettingsSection />);
      await waitFor(() => expect(keyButton()).toBeInTheDocument());
      fireEvent.click(keyButton());
      press({ key: 'F9', code: 'F9', altKey: true }, keyButton());
      await waitFor(() => expect(desktop.globalChord).toBe('Alt+F9'));
      fireEvent.click(await screen.findByRole('button', { name: 'Rétablir Ctrl+Alt+Espace' }));
      await waitFor(() => expect(desktop.globalChord).toBe('Ctrl+Alt+Space'));
      fireEvent.click(screen.getByRole('switch', { name: 'Capture rapide globale' }));
      await waitFor(() => expect(desktop.globalChord).toBeNull());
      expect(keyButton()).toBeDisabled();
    });

    it('état « indisponible » quand le système refuse au démarrage (critère 9)', async () => {
      desktop.takenChords.add('Ctrl+Alt+Space');
      renderShell(<ShortcutsSettingsSection />);
      expect(await screen.findByText('Indisponible : combinaison prise par une autre application')).toBeInTheDocument();
    });
  });

  it('Ctrl+, ouvre Réglages sauf sous une fenêtre modale ; Échap ferme la surcouche du dessus', async () => {
    renderShell();
    act(() => useNavigationStore.getState().navigate({ tab: 'events' }));
    press({ key: ',', code: 'Comma', ctrlKey: true });
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'settings', screen: 'home' });
    ctrlSlash();
    await screen.findByRole('dialog');
    act(() => useNavigationStore.getState().navigate({ tab: 'events' }));
    press({ key: ',', code: 'Comma', ctrlKey: true });
    expect(useNavigationStore.getState().route.tab).toBe('events');
    act(() => useNavigationStore.getState().closeOverlay());
    act(() => useNavigationStore.getState().openOverlay({ kind: 'search' }));
    press({ key: 'Escape', code: 'Escape' });
    expect(useNavigationStore.getState().overlays).toHaveLength(0);
  });
});
