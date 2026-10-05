import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import type { LocalDate } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import type { CaptureInput } from './useQuickInput';
import type * as LoaderModule from './absoluteDatesLoader';
import { setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Chemin « avant chargement » (PERF-02) : le chargeur est tenu fermé par une porte, puis ouvert, pour voir l’avant et l’après. */
const gate = vi.hoisted(() => {
  let open: () => void = () => undefined;
  const state = { promise: Promise.resolve() };
  return {
    state,
    close(): void {
      state.promise = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release(): void {
      open();
    },
  };
});

vi.mock('./absoluteDatesLoader', async () => {
  const real = await vi.importActual<typeof LoaderModule>('./absoluteDatesLoader');
  const make = () =>
    real.createAbsoluteDatesLoader(async () => {
      await gate.state.promise;
      return import('../../domain/chronoAbsolute');
    });
  const ctl = { current: make() };
  return {
    ...real,
    getAbsoluteDateParser: () => ctl.current.get(),
    loadAbsoluteDates: () => ctl.current.load(),
    subscribeAbsoluteDateParser: (listener: () => void) => ctl.current.subscribe(listener),
    /** Repart d’un chargeur neuf (analyseur absent). */
    resetForTest: () => {
      ctl.current = make();
    },
  };
});

const { useQuickInputWithClock } = await import('./useQuickInput');
const { createTaskFromCaptureText } = await import('./captureUseCases');
const { TodayAddRow } = await import('../today/TodayCreate');
const loader = (await import('./absoluteDatesLoader')) as typeof LoaderModule & { resetForTest: () => void };

describe('avant l’arrivée de l’analyseur des dates écrites', () => {
  beforeEach(() => {
    loader.resetForTest();
    gate.close();
  });
  afterEach(() => gate.release());

  it('la saisie en cours n’est pas écrasée à l’arrivée ; la date apparaît alors', async () => {
    useAppStore.setState({ spaces: [], projects: [], spaceFilter: 'all' });
    const clock = createManualClock('2026-10-05T10:00:00');
    const { result } = renderHook(() => useQuickInputWithClock(clock));
    act(() => result.current.setText('Dentiste le 12 octobre'));
    // Avant : texte intact, aucune date lue par la grammaire locale seule.
    expect(result.current.text).toBe('Dentiste le 12 octobre');
    expect(result.current.parse.date).toBeNull();
    act(() => result.current.setText('Dentiste le 12 octobre à 9h'));
    expect(result.current.parse.time).toBe('09:00');
    gate.release();
    await waitFor(() => expect(result.current.parse.date).toBe('2026-10-12'));
    expect(result.current.text).toBe('Dentiste le 12 octobre à 9h');
    expect(result.current.parse.title).toBe('Dentiste');
  });

  describe('création depuis la mini-fenêtre', () => {
    let h: TodayHarness;
    beforeEach(async () => {
      h = await setupToday('b9a1');
    });
    afterEach(() => teardownToday(h));

    it('Aujourd’hui : « Entrée » avant le chargement attend l’analyseur et envoie la date du 12 octobre (TodayCreate)', async () => {
      const captures: CaptureInput[] = [];
      render(
        <AppContainerProvider container={h.container}>
          <TodayAddRow
            layout="pc"
            today={h.today}
            inputRef={createRef<HTMLInputElement>() as React.RefObject<HTMLInputElement>}
            onSubmit={(capture) => {
              captures.push(capture);
              return Promise.resolve(true);
            }}
          />
        </AppContainerProvider>,
      );
      expect(loader.getAbsoluteDateParser()).toBeNull();
      const field = screen.getByLabelText('Nouvelle tâche');
      fireEvent.change(field, { target: { value: 'Dentiste le 12 octobre' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(captures).toHaveLength(0);
      gate.release();
      await waitFor(() => expect(captures).toHaveLength(1));
      expect(captures[0]?.title).toBe('Dentiste');
      expect(captures[0]?.date).toMatch(/-10-12$/);
    });

    it('appelée avant le chargement, elle attend et crée une seule tâche datée du 12 octobre', async () => {
      expect(loader.getAbsoluteDateParser()).toBeNull();
      let settled = false;
      const created = createTaskFromCaptureText(h.container, 'Dentiste le 12 octobre', []).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      gate.release();
      const result = await created;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.task).toMatchObject({ title: 'Dentiste' });
      expect(result.task.date).toMatch(/-10-12$/);
      const sameDay = await h.container.data.repos.tasks.listForDay(result.task.date as LocalDate, 'all');
      expect(sameDay.filter((task) => task.title === 'Dentiste')).toHaveLength(1);
    });
  });
});
