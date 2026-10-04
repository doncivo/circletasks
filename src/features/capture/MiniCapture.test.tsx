import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { addDays } from '../../domain/localDate';
import type { Task } from '../../domain/model';
import { useAppStore } from '../app/appStore';
import { createMainBridge, createMemoryBus, createWindowBridge } from '../../platform/capture';
import { setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { startCaptureHost, type CaptureHost } from './captureHost';
import { MiniCapture } from './MiniCapture';

/**
 * Mini-fenêtre de capture rapide (Q-01) bout en bout dans jsdom : la fenêtre n'a pas de base, elle parle à la fenêtre principale
 * (hôte réel sur une base en mémoire) par un pont en mémoire, comme les deux fenêtres Tauri.
 */
describe('mini-fenêtre de capture rapide (Q-01)', () => {
  let h: TodayHarness;
  let host: CaptureHost;
  let bus: ReturnType<typeof createMemoryBus>;
  let shown: () => Promise<void>;
  let blurred: () => Promise<void>;

  beforeEach(async () => {
    h = await setupToday('b102');
    bus = createMemoryBus();
    host = startCaptureHost(h.container, createMainBridge(bus.main));
    // La mini-fenêtre ne connaît rien de l'application : on vide le magasin, le contexte arrive par le pont.
    useAppStore.setState({ spaces: [], projects: [], spaceFilter: 'all' });
    const mainSpaces = await h.container.data.repos.spaces.listAll();
    render(<MiniCapture bridge={createWindowBridge(bus.window)} />);
    shown = () => bus.main.emit('quick-capture', 'capture://shown', null);
    blurred = () => bus.main.emit('quick-capture', 'capture://blurred', null);
    // Le magasin partagé sert ici aux deux côtés (même processus de test) : la fenêtre principale republie ses espaces.
    act(() => useAppStore.getState().setSpaces(mainSpaces));
    await waitFor(() => expect(useAppStore.getState().spaces.length).toBeGreaterThan(0));
  });

  afterEach(async () => {
    host.dispose();
    vi.useRealTimers();
    await teardownToday(h);
  });

  const field = (): HTMLInputElement => screen.getByLabelText('Nouvelle tâche');
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const tasks = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];
  const hidden = (): boolean => bus.invoked.includes('hide_quick_capture');

  it('fenêtre annoncée « Capture rapide », champ « Nouvelle tâche » focalisé, aide visible (critères 1 et 11)', () => {
    expect(screen.getByRole('dialog', { name: 'Capture rapide' })).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(screen.getByText('CAPTURE RAPIDE')).toBeInTheDocument();
    expect(screen.getByText('Entrée pour ajouter · Ctrl+Entrée pour enchaîner · Échap pour fermer')).toBeInTheDocument();
  });

  it('Entrée crée la tâche (titre, date, heure, espace), vide le champ et ferme la fenêtre (critère 2)', async () => {
    type('Appeler le notaire demain 10h #pro');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    expect(within(group).getByText('Pro')).toBeInTheDocument();
    expect(within(group).getByText('demain · 10:00')).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(hidden()).toBe(true));
    const [task] = await tasks();
    expect(task).toMatchObject({ title: 'Appeler le notaire', spaceId: SPACE_PRO_ID, date: addDays(h.today, 1), time: '10:00' });
    expect(field()).toHaveValue('');
  });

  it('aucune donnée n’est écrite avant Entrée (aucun brouillon, critère 9)', async () => {
    type('Appeler le notaire');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await tasks()).toEqual([]);
    expect(await h.container.data.repos.settings.get('device.id')).toBeDefined();
  });

  it('Ctrl+Entrée crée, vide le champ et garde la fenêtre ouverte avec « Ajoutée : <titre> » pendant 3 s (critère 3)', async () => {
    type('Payer la cantine');
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    const status = await screen.findByText('Ajoutée : Payer la cantine');
    expect(status).toHaveAttribute('role', 'status');
    expect(hidden()).toBe(false);
    expect(field()).toHaveValue('');
    expect(field()).toHaveFocus();
    expect(await tasks()).toHaveLength(1);
    // Une deuxième tâche s'enchaîne ; le message suit la dernière.
    type('Acheter du pain');
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true });
    await screen.findByText('Ajoutée : Acheter du pain');
    expect(await tasks()).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText(/^Ajoutée/)).toBeNull(), { timeout: 4_500 });
    expect(screen.getByText(/Entrée pour ajouter/)).toBeInTheDocument();
  });

  it('Échap ferme sans rien créer (critère 4)', async () => {
    type('Appeler le notaire');
    fireEvent.keyDown(field(), { key: 'Escape' });
    await waitFor(() => expect(hidden()).toBe(true));
    expect(await tasks()).toEqual([]);
  });

  it('perte du focus : fermeture seulement si le champ est vide (critère 4)', async () => {
    type('Une saisie en cours');
    await blurred();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hidden()).toBe(false);
    expect(field()).toHaveValue('Une saisie en cours');
    type('   ');
    await blurred();
    await waitFor(() => expect(hidden()).toBe(true));
  });

  it('titre vide : le champ tremble, un message l’explique, la fenêtre reste ouverte, rien n’est écrit (critère 6)', async () => {
    type('#pro');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(await screen.findByText('Saisissez un titre.')).toBeInTheDocument();
    expect(field().closest('.ct-mini__row')).toHaveAttribute('data-shake', 'true');
    expect(hidden()).toBe(false);
    expect(await tasks()).toEqual([]);
  });

  it('à chaque ouverture le champ est vidé et focalisé : aucun brouillon conservé (critère 9)', async () => {
    type('ancien texte');
    (document.activeElement as HTMLElement | null)?.blur();
    await shown();
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(field()).toHaveFocus();
  });

  it('une marque retirée de l’aperçu reste du texte dans la tâche créée', async () => {
    type('Parler de #pro demain');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    fireEvent.click(within(group).getByRole('button', { name: /Retirer Pro/ }));
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(hidden()).toBe(true));
    const [task] = await tasks();
    expect(task?.title).toBe('Parler de #pro');
    expect(task?.date).toBe(addDays(h.today, 1));
  });

  it('« # » propose les espaces et la fenêtre grandit pour la liste (suggestions Q-06)', async () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return { bottom: this.getAttribute('role') === 'listbox' ? 300 : 120, top: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    });
    type('Appeler #');
    expect(await screen.findByRole('listbox', { name: 'Suggestions' })).toBeInTheDocument();
    await waitFor(() => expect(bus.invoked).toContain('resize_quick_capture:{"height":312}'));
    // La liste fermée, la fenêtre reprend sa taille.
    type('Appeler');
    await waitFor(() => expect(bus.invoked).toContain('resize_quick_capture:{"height":160}'));
    rect.mockRestore();
  });

  it('bouton micro « Dicter » : focalise le champ, affiche l’aide Win + H, ne crée jamais seul (Q-03 critères 1 à 3)', async () => {
    const mic = screen.getByRole('button', { name: 'Dicter' });
    expect(mic).toBeEnabled();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(mic);
    expect(field()).toHaveFocus();
    const help = await screen.findByText('Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter');
    expect(field()).toHaveAttribute('aria-describedby', help.id);
    // Windows dicte dans le champ comme une saisie : rien n'est créé sans Entrée.
    type('appeler le notaire demain dix heures');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await tasks()).toEqual([]);
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    expect(within(group).getByText('demain · 10:00')).toBeInTheDocument();
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(async () => expect(await tasks()).toHaveLength(1));
    expect((await tasks())[0]).toMatchObject({ title: 'appeler le notaire', time: '10:00' });
  });

  it('Tab reste dans la fenêtre (piège de focus)', () => {
    type('Appeler #pro demain');
    const buttons = screen.getAllByRole('button');
    const last = buttons[buttons.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(field()).toHaveFocus();
    fireEvent.keyDown(field(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
