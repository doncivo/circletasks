import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asLocalTime } from '../../domain/types';
import { TABS } from '../app/navigation';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { registerTodaySource } from './todaySources';

/** Compléments QA du lot A : critères sans test dédié (A-02 critère 10, A-04 critère 3). */

function pointer(target: EventTarget, type: string, clientY: number): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('QA lot A', () => {
  let h: TodayHarness;
  const off: (() => void)[] = [];
  beforeEach(async () => {
    h = await setupToday('1901');
    mockViewport(1440);
  });
  afterEach(async () => {
    for (const fn of off.splice(0)) fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownToday(h);
  });

  it('A-02 critère 10 : un événement ne se glisse pas et ne déplace aucune tâche', async () => {
    off.push(
      registerTodaySource({
        id: 'qa-event',
        load: () =>
          Promise.resolve({
            events: [{ id: 'e1', title: 'Point client', allDay: false, startTime: asLocalTime('08:00'), spaceId: null, calendarName: 'Google Agenda', icon: null }],
          }),
      }),
    );
    await seedTask(h, { title: 'A' });
    await seedTask(h, { title: 'B' });
    renderToday(h.container);
    await screen.findByText('Point client');
    const before = [...document.querySelectorAll('.ct-today__list .ct-list-row__title')].map((n) => n.textContent);
    const items = screen.getAllByRole('listitem');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = items.indexOf(this);
      return { top: index * 60, bottom: index * 60 + 60, left: 0, right: 100, width: 100, height: 60, x: 0, y: index * 60, toJSON: () => ({}) };
    });
    pointer(screen.getByText('Point client'), 'pointerdown', 10);
    pointer(window, 'pointermove', 200);
    pointer(window, 'pointerup', 200);
    const after = [...document.querySelectorAll('.ct-today__list .ct-list-row__title')].map((n) => n.textContent);
    expect(after).toEqual(before);
    expect(screen.queryByRole('button', { name: /Déplacer/ })).toBeNull();
  });

  it('A-04 critère 3 : l’onglet « Tâches » est le premier de la colonne d’onglets', () => {
    expect(TABS[0]?.id).toBe('tasks');
  });
});
