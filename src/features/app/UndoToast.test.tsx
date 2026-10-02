import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { AppContainerProvider } from './AppContainerContext';
import { createAppContainer, type AppContainer } from './container';
import { UNDO_TOAST_MS, type UndoableCommand } from './undo';
import { UndoToast } from './UndoToast';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000021');
const CTRL_Z = { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false };

const command = (title: string, undo: UndoableCommand['undo'] = async () => 'undone'): UndoableCommand => ({
  kind: 'postpone',
  count: 1,
  labelKey: 'undo.postponeTomorrow',
  labelParams: { title },
  undo,
});

describe('UndoToast global (T-13)', () => {
  let container: AppContainer;

  beforeEach(() => {
    vi.useFakeTimers();
    const clock = createManualClock('2026-10-02T08:00:00.000Z');
    container = createAppContainer({ clock, hlc: createHlcClock({ clock, deviceId: DEVICE }), data: {} as never });
    render(
      <AppContainerProvider container={container}>
        <UndoToast />
      </AppContainerProvider>,
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const push = (c: UndoableCommand) => act(() => container.undo.push(c));
  const pressCtrlZ = () => act(async () => void container.shortcuts.handle(CTRL_Z));

  it('affiche le message de l’action 5 s avec « Annuler », puis disparaît (critère 1)', () => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    push(command('Courses'));
    expect(screen.getByRole('status')).toHaveTextContent('« Courses » reportée à demain');
    act(() => void vi.advanceTimersByTime(UNDO_TOAST_MS - 1));
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('« Annuler » rétablit l’action et ferme le message (critère 2)', async () => {
    const undo = vi.fn(async () => 'undone' as const);
    push(command('Courses', undo));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Annuler' })));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('deux actions en moins de 5 s : le message affiche la dernière et le minuteur repart (critère 3)', () => {
    push(command('Premier'));
    act(() => void vi.advanceTimersByTime(4000));
    push(command('Second'));
    expect(screen.getByRole('status')).toHaveTextContent('« Second »');
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('Ctrl+Z annule la dernière action, même après la disparition du message (critère 4)', async () => {
    const calls: string[] = [];
    push(command('Premier', async () => (calls.push('premier'), 'undone')));
    push(command('Second', async () => (calls.push('second'), 'undone')));
    act(() => void vi.advanceTimersByTime(UNDO_TOAST_MS));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await pressCtrlZ();
    await pressCtrlZ();
    expect(calls).toEqual(['second', 'premier']);
    // Le message de l'action annulée ne revient pas pour l'action précédente.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('Ctrl+Z dans un champ de saisie reste l’annulation de texte (critère 4)', async () => {
    const undo = vi.fn(async () => 'undone' as const);
    push(command('Courses', undo));
    await act(async () => void container.shortcuts.handle({ ...CTRL_Z, editable: true }));
    expect(undo).not.toHaveBeenCalled();
  });

  it('21 actions : seules les 20 dernières sont annulables, la 21e annulation est sans effet (critère 5)', async () => {
    const calls: number[] = [];
    for (let i = 1; i <= 21; i += 1) push(command(`T${i}`, async () => (calls.push(i), 'undone')));
    for (let i = 0; i < 21; i += 1) await pressCtrlZ();
    expect(calls).toHaveLength(20);
    expect(calls[0]).toBe(21);
    expect(calls.at(-1)).toBe(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('élément modifié depuis : « Action impossible à annuler : la tâche a changé », rien d’autre (critère 7)', async () => {
    push(command('Courses', async () => 'stale'));
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Annuler' })));
    expect(screen.getByRole('status')).toHaveTextContent('Action impossible à annuler : la tâche a changé');
    expect(screen.queryByRole('button', { name: 'Annuler' })).not.toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(UNDO_TOAST_MS));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('échec d’écriture à l’annulation : message dédié, aucun rejet non géré', async () => {
    push(command('Courses', () => Promise.reject(new Error('boom'))));
    await pressCtrlZ();
    expect(screen.getByRole('status')).toHaveTextContent('Impossible d’annuler cette action.');
  });

  it('pile vide : Ctrl+Z sans effet ni message', async () => {
    await pressCtrlZ();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('survol : le délai de 5 s est suspendu (critère 9)', () => {
    push(command('Courses'));
    fireEvent.mouseEnter(screen.getByRole('status'));
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('status')).toBeInTheDocument();
    fireEvent.mouseLeave(screen.getByRole('status'));
    act(() => void vi.advanceTimersByTime(UNDO_TOAST_MS));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
