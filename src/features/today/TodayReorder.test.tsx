import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { Routine } from '../../domain/model';
import { asEntityId, asLocalTime, type RoutineId } from '../../domain/types';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createAppContainer } from '../app/container';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { registerTodaySource } from './todaySources';

const alt = (key: 'ArrowUp' | 'ArrowDown'): KeyInput => ({ key, code: key, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, editable: false });

const titles = (): string[] => screen.getAllByRole('listitem').map((item) => item.querySelector('.ct-list-row__title')?.textContent ?? '');

function pointer(target: EventTarget, type: string, clientY: number, button = 0): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY, button });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('Aujourd’hui : réordonner la liste (A-02)', () => {
  let h: TodayHarness;
  const off: (() => void)[] = [];

  beforeEach(async () => {
    h = await setupToday('102');
    mockViewport(1440);
  });
  afterEach(async () => {
    for (const fn of off.splice(0)) fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownToday(h);
  });

  const focusTitle = (title: string): HTMLElement => {
    const button = screen.getByRole('button', { name: title });
    act(() => button.focus());
    return button;
  };

  it('Alt+↓ descend la ligne, le focus la suit, l’annonce est faite et l’ordre est écrit (critère 3)', async () => {
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    await seedTask(h, { title: 'C' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'A' });
    focusTitle('A');

    act(() => {
      h.container.shortcuts.handle(alt('ArrowDown'));
    });
    await waitFor(() => expect(titles()).toEqual(['B', 'A', 'C']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toHaveFocus());
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Déplacée en position 2 sur 3');
    const stored = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(stored.map((task) => task.title)).toEqual(['B', 'A', 'C']);
  });

  it('Alt+↑ remonte la ligne ; en tête, rien ne bouge', async () => {
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'A' });
    focusTitle('B');
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await waitFor(() => expect(titles()).toEqual(['B', 'A']));
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    expect(titles()).toEqual(['B', 'A']);
  });

  it('l’ordre est conservé au redémarrage : un nouvel écran sur la même base le relit (critère 4)', async () => {
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'A' });
    focusTitle('B');
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await waitFor(() => expect(titles()).toEqual(['B', 'A']));
    cleanup();

    const restarted = createAppContainer({ clock: h.db.clock, hlc: createHlcClock({ clock: h.db.clock, deviceId: h.db.deviceId }), data: h.db.data });
    renderToday(restarted);
    await screen.findByRole('button', { name: 'A' });
    expect(titles()).toEqual(['B', 'A']);
  });

  it('l’heure prime : D passe au-dessus de C mais pas au-dessus des tâches horodatées (critère 5)', async () => {
    await seedTask(h, { title: '09h', time: '09:00' });
    await seedTask(h, { title: '14h', time: '14:00' });
    await seedTask(h, { title: 'C' });
    await seedTask(h, { title: 'D' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'D' });
    focusTitle('D');
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await waitFor(() => expect(titles()).toEqual(['09h', '14h', 'D', 'C']));
    // D est maintenant la première sans heure : monter encore le ramène à sa place, avec annonce.
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Position inchangée : l’heure prime'));
    expect(titles()).toEqual(['09h', '14h', 'D', 'C']);
  });

  it('une tâche terminée ne se déplace pas (critère 7)', async () => {
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : A' }));
    await waitFor(() => expect(titles()).toEqual(['B', 'A']));
    focusTitle('A');
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(titles()).toEqual(['B', 'A']);
  });

  it('annuler le déplacement rétablit l’ordre (message « Tâche déplacée » et Ctrl+Z, critère 8)', async () => {
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'A' });
    focusTitle('B');
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await waitFor(() => expect(titles()).toEqual(['B', 'A']));
    expect(await screen.findByRole('status')).toHaveTextContent('Tâche déplacée');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(titles()).toEqual(['A', 'B']));
  });

  it('souris : glisser une ligne la dépose à la position relâchée et persiste (critère 2)', async () => {
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    await seedTask(h, { title: 'C' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'A' });
    const items = screen.getAllByRole('listitem');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = items.indexOf(this);
      const top = index * 60;
      return { top, bottom: top + 60, left: 0, right: 100, width: 100, height: 60, x: 0, y: top, toJSON: () => ({}) };
    });
    // C (centre 150) est glissée jusqu'au centre 20 : en tête.
    pointer(screen.getByRole('button', { name: 'C' }), 'pointerdown', 150);
    pointer(window, 'pointermove', 20);
    expect(items[0]).toHaveAttribute('data-drop', 'before');
    pointer(window, 'pointerup', 20);
    await waitFor(() => expect(titles()).toEqual(['C', 'A', 'B']));
    const stored = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(stored.map((task) => task.title)).toEqual(['C', 'A', 'B']);
  });

  it('une routine n’a pas de poignée et ne se glisse pas ; elle reste placée par son heure (critère 6)', async () => {
    const routine = {
      id: asEntityId<RoutineId>('70000000-0000-4000-8000-000000000001'),
      spaceId: SPACE_PRO_ID,
      title: 'Boire de l’eau',
      icon: null,
      time: asLocalTime('08:30'),
      paused: false,
      archived: false,
      deletedAt: null,
    } as unknown as Routine;
    off.push(registerTodaySource({ id: 'routines', load: () => Promise.resolve({ routines: [{ routine, done: false }] }) }));
    await seedTask(h, { title: 'A' });
    renderToday(h.container);
    await screen.findByText('Boire de l’eau');
    const items = screen.getAllByRole('listitem');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = items.indexOf(this);
      return { top: index * 60, bottom: index * 60 + 60, left: 0, right: 100, width: 100, height: 60, x: 0, y: index * 60, toJSON: () => ({}) };
    });
    pointer(screen.getByText('Boire de l’eau'), 'pointerdown', 30);
    pointer(window, 'pointermove', 100);
    pointer(window, 'pointerup', 100);
    expect(titles()).toEqual(['Boire de l’eau', 'A']);
    expect(screen.queryByRole('button', { name: /Déplacer/ })).toBeNull();
  });
});
