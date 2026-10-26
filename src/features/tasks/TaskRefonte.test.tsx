import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate, asLocalTime } from '../../domain/types';
import { defaultRecurrence } from '../../domain/recurrenceRules';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { createTaskUseCases } from './createTaskUseCases';
import { TaskCreateSheet, type TaskCreateSheetProps } from './TaskCreateSheet';
import { TaskDetail } from './TaskDetail';

describe('UI-REFONTE-01 — écrans iPhone', () => {
  let h: TodayHarness;
  beforeEach(async () => { mockViewport(440); h = await setupToday('a901'); });
  afterEach(async () => { await teardownToday(h); });

  function create(onCreate = vi.fn(async (_input: Parameters<TaskCreateSheetProps['onCreate']>[0]) => true)) {
    render(<AppContainerProvider container={h.container}><TaskCreateSheet viewedDate={h.today} today={h.today} spaces={useAppStore.getState().spaces} initialSpaceId={SPACE_PRO_ID} onCreate={onCreate} onClose={vi.fn()} /></AppContainerProvider>);
    return onCreate;
  }
  async function detail(repeat = false, date = asLocalDate('2026-10-22')) {
    const made = await createTaskUseCases(h.container).create({ title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, date, time: asLocalTime('19:30'), reminderOffsets: [0], ...(repeat ? { recurrence: defaultRecurrence('daily', date) } : {}) });
    if (!made.ok) throw Error('create failed');
    useNavigationStore.getState().openDetail({ type: 'task', id: made.value.id });
    render(<AppContainerProvider container={h.container}><TaskDetail /></AppContainerProvider>);
    await screen.findByText('Rappels');
    return made.value;
  }

  it('garde le focus immédiat, trois décisions visibles et les options repliées', async () => {
    create();
    expect(screen.getByLabelText('Titre')).toHaveFocus();
    expect(await screen.findByRole('button', { name: 'Ajouter la tâche' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Date :/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Heure :/ })).toBeVisible();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Rattacher à mon objectif' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Plus d.options/ }));
    await screen.findByText('Aucun objectif cette semaine');
    expect(screen.queryByRole('switch', { name: 'Rattacher à mon objectif' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Plus d.options/ }));
    expect(screen.queryByRole('switch', { name: 'Rattacher à mon objectif' })).toBeNull();
  });

  it('choisit une heure, replie le sélecteur puis crée avec le rappel par défaut conservé', async () => {
    const save = create();
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: 'Essai compact' } });
    fireEvent.click(await screen.findByRole('button', { name: /Heure :/ }));
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Heures' }), { key: 'ArrowUp' });
    const editor = screen.getByRole('spinbutton', { name: 'Heures' }).closest('.ct-task-schedule__editor');
    if (!(editor instanceof HTMLElement)) throw Error('editor absent');
    fireEvent.click(within(editor).getByRole('button', { name: 'Fermer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter la tâche' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[0]).toMatchObject({ title: 'Essai compact', choice: { date: h.today, time: '00:00' }, reminderOffsets: [0] });
  });

  it('suit le cadre du clavier et retire ses écouteurs à la fermeture', async () => {
    const viewport = Object.assign(new EventTarget(), { height: 600, offsetTop: 0 });
    const off = vi.spyOn(viewport, 'removeEventListener');
    vi.stubGlobal('visualViewport', viewport);
    create();
    const dialog = screen.getByRole('dialog', { name: 'Nouvelle tâche' });
    expect(dialog.parentElement).toHaveStyle({ height: '600px' });
    act(() => { viewport.height = 480; viewport.offsetTop = 24; viewport.dispatchEvent(new Event('resize')); });
    expect(dialog.parentElement).toHaveStyle({ height: '480px', top: '24px' });
    const { cleanup } = await import('@testing-library/react');
    cleanup();
    expect(off).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(off).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('distingue échéance et heure de rappel décalée par le silence', async () => {
    await detail();
    expect(screen.getByText('Jeu. 22 oct. · 19:30')).toBeInTheDocument();
    expect(screen.getByText('Ven. 23 oct. · 08:00')).toBeInTheDocument();
    expect(screen.getByText('Décalé par la plage silencieuse de Pro')).toBeInTheDocument();
    expect(screen.getByText('Projet')).toBeInTheDocument();
    const actions = screen.getByRole('button', { name: 'Dupliquer la tâche' });
    const focus = screen.getByRole('button', { name: 'Lancer un Focus' });
    expect(actions.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('propose de définir un objectif sans interrupteur inutilisable et sauve la note avant de quitter', async () => {
    const task = await detail(false, h.today);
    const define = await screen.findByRole('button', { name: 'En définir un' });
    expect(screen.queryByRole('switch', { name: 'Rattacher à mon objectif' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Note avant navigation' } });
    fireEvent.click(define);
    await waitFor(async () => expect((await h.db.data.repos.tasks.getById(task.id))?.note).toBe('Note avant navigation'));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'goals' });
  });

  it('reste sur la série quand la note exige un choix de portée avant la navigation', async () => {
    const task = await detail(true, h.today);
    const previous = useNavigationStore.getState().route;
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Note de série' } });
    fireEvent.click(await screen.findByRole('button', { name: 'En définir un' }));
    const question = await screen.findByRole('alertdialog');
    expect(within(question).getByRole('button', { name: 'Cette occurrence' })).toBeInTheDocument();
    expect(useNavigationStore.getState().route).toEqual(previous);
    expect((await h.db.data.repos.tasks.getById(task.id))?.note).toBe('');
  });

  it('ne promet pas de définir un objectif pour une autre semaine depuis l’écran de la semaine courante', async () => {
    await detail();
    await screen.findByText('Aucun objectif cette semaine');
    expect(screen.queryByRole('button', { name: 'En définir un' })).toBeNull();
  });
});
