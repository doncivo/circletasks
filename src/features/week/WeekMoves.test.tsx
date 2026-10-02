import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { RecurrenceFields, Routine } from '../../domain/model';
import { asEntityId, asLocalDate, asLocalTime, type RoutineId } from '../../domain/types';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import type { KeyInput } from '../app/shortcuts';
import { registerTodaySource } from '../today/todaySources';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : ven. 2 oct. 2026 (semaine du lundi 28 sept. au dimanche 4 oct.). */
const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key: k, code: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false, ...mods });
const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const titlesOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__title')].map((el) => el.textContent ?? '');
const focusTitle = (title: string): void => act(() => screen.getByRole('button', { name: title }).focus());
const press = (input: KeyInput, h: WeekHarness): void => {
  act(() => {
    h.container.shortcuts.handle(input);
  });
};

function pointer(target: EventTarget, type: string, init: { x?: number; y?: number; touch?: boolean } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x ?? 10, clientY: init.y ?? 10, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: init.touch ? 'touch' : 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Mise en page simulée : chaque jour est une colonne de 100 px de large, chaque carte une hauteur de 40 px. */
function stubLayout(): void {
  const dates = [...document.querySelectorAll<HTMLElement>('.ct-week-day')].map((el) => el.dataset['date'] ?? '');
  document.elementsFromPoint = (x: number) => {
    const column = Math.floor(x / 100);
    const date = dates[column];
    return date ? [day(date)] : [document.body];
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const slots = [...(this.closest('.ct-week-day')?.querySelectorAll('[data-drag-id]') ?? [])];
    const index = slots.indexOf(this);
    const top = index < 0 ? 0 : index * 40;
    return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) };
  });
}

describe('Semaine : déplacer une tâche (S-02)', () => {
  let h: WeekHarness;
  const off: (() => void)[] = [];

  beforeEach(async () => {
    h = await setupWeek('302');
    mockViewport(1440);
  });
  afterEach(async () => {
    for (const fn of off.splice(0)) fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  describe('clavier (critère 9)', () => {
    it('Alt+→ envoie la tâche sélectionnée au jour suivant, Alt+← la ramène ; annulable', async () => {
      const task = await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-30'), time: '09:00' });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Envoyer la facture' });
      focusTitle('Envoyer la facture');

      press(key('ArrowRight', { altKey: true }), h);
      await waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Envoyer la facture']));
      expect(titlesOf('2026-09-30')).toEqual([]);
      expect((await h.container.data.repos.tasks.getById(task.id))?.date).toBe('2026-10-01');
      expect(await screen.findByRole('status')).toHaveTextContent('« Envoyer la facture » déplacée au jeu. 1 oct.');

      fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Annuler' }));
      await waitFor(() => expect(titlesOf('2026-09-30')).toEqual(['Envoyer la facture']));
      expect((await h.container.data.repos.tasks.getById(task.id))?.date).toBe('2026-09-30');
    });

    it('n’envoie pas la tâche hors de la semaine affichée', async () => {
      await seedTask(h, { title: 'Lundi', date: asLocalDate('2026-09-28') });
      await seedTask(h, { title: 'Dimanche', date: asLocalDate('2026-10-04') });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Lundi' });
      focusTitle('Lundi');
      press(key('ArrowLeft', { altKey: true }), h);
      focusTitle('Dimanche');
      press(key('ArrowRight', { altKey: true }), h);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(titlesOf('2026-09-28')).toEqual(['Lundi']);
      expect(titlesOf('2026-10-04')).toEqual(['Dimanche']);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('Ctrl+D reporte la tâche sélectionnée à demain, annulable (T-05)', async () => {
      await seedTask(h, { title: 'À reporter', date: asLocalDate('2026-10-02') });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'À reporter' });
      focusTitle('À reporter');
      press(key('d', { ctrlKey: true }), h);
      await waitFor(() => expect(titlesOf('2026-10-03')).toEqual(['À reporter']));
      expect(await screen.findByRole('status')).toHaveTextContent('« À reporter » reportée à demain');
    });

    it('Alt+↓ / Alt+↑ réordonnent le jour, l’heure prime (critère 10), le focus suit et l’annonce est faite', async () => {
      await seedTask(h, { title: 'À 09h', date: asLocalDate('2026-09-30'), time: '09:00' });
      await seedTask(h, { title: 'A', date: asLocalDate('2026-09-30') });
      await seedTask(h, { title: 'B', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'B' });
      focusTitle('A');
      press(key('ArrowDown', { altKey: true }), h);
      await waitFor(() => expect(titlesOf('2026-09-30')).toEqual(['À 09h', 'B', 'A']));
      await waitFor(() => expect(screen.getByRole('button', { name: 'A' })).toHaveFocus());
      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Déplacée en position 3 sur 3');
      // « B » est la première tâche sans heure : elle ne passe pas devant la tâche à 09:00.
      focusTitle('B');
      press(key('ArrowUp', { altKey: true }), h);
      await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Position inchangée'));
      expect(titlesOf('2026-09-30')).toEqual(['À 09h', 'B', 'A']);
    });

    it('une occurrence récurrente pose la question de portée avant tout déplacement (T-10)', async () => {
      const rule: RecurrenceFields = { freq: 'daily', interval: 1, weekdays: [], monthDay: null, nthWeekday: null, until: null, count: null };
      h.db.clock.advance(1);
      const created = await createTaskUseCases(h.container).create({ title: 'Chaque jour', spaceId: SPACE_PRO_ID, date: asLocalDate('2026-09-30'), recurrence: rule });
      if (!created.ok) throw new Error('création impossible');
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Chaque jour' });
      focusTitle('Chaque jour');

      press(key('ArrowRight', { altKey: true }), h);
      const question = await screen.findByRole('alertdialog');
      expect(question).toHaveTextContent('Déplacer « Chaque jour » ?');
      expect((await h.container.data.repos.tasks.getById(created.value.id))?.date).toBe('2026-09-30'); // rien n'a bougé

      fireEvent.click(within(question).getByRole('button', { name: 'Annuler' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(titlesOf('2026-09-30')).toEqual(['Chaque jour']);

      press(key('ArrowRight', { altKey: true }), h);
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cette occurrence' }));
      await waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Chaque jour']));
      const stored = await h.container.data.repos.tasks.getById(created.value.id);
      expect(stored).toMatchObject({ date: '2026-10-01' });
      expect(stored?.seriesTemplate).toMatchObject({ date: '2026-09-30' }); // la série garde son ancre

      focusTitle('Chaque jour');
      press(key('ArrowRight', { altKey: true }), h);
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Toutes les suivantes' }));
      await waitFor(() => expect(titlesOf('2026-10-02')).toEqual(['Chaque jour']));
      expect((await h.container.data.repos.tasks.getById(created.value.id))?.seriesTemplate).toBeNull(); // la série repart de cette date
    });
  });

  describe('glisser à la souris (critères 1 à 3, 5 à 7, 10)', () => {
    it('affiche « Déposer ici · … » au survol d’un autre jour, puis y déplace la carte au lâcher, sans rechargement', async () => {
      const task = await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-30'), time: '09:00' });
      renderWeek(h.container);
      const card = (await screen.findByRole('button', { name: 'Envoyer la facture' })).closest('[data-drag-id]') as HTMLElement;
      stubLayout();
      pointer(card, 'pointerdown', { x: 250, y: 10 });
      pointer(window, 'pointermove', { x: 350, y: 20 }); // colonne du jeudi 1er oct.
      await waitFor(() => expect(screen.getByText('Déposer ici · jeu. 1')).toBeInTheDocument());
      expect(screen.queryByText('Déposer ici · mer. 30')).not.toBeInTheDocument();
      pointer(window, 'pointerup', { x: 350, y: 20 });
      await waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Envoyer la facture']));
      expect(titlesOf('2026-09-30')).toEqual([]);
      const stored = await h.container.data.repos.tasks.getById(task.id);
      expect(stored).toMatchObject({ date: '2026-10-01', time: '09:00', spaceId: SPACE_PRO_ID, carriedOver: false });
      expect(screen.queryByText(/Déposer ici/)).not.toBeInTheDocument();
      expect(await screen.findByRole('status')).toHaveTextContent('« Envoyer la facture » déplacée au jeu. 1 oct.');
    });

    it('un lâcher hors d’un jour, ou Échap, ne change rien', async () => {
      await seedTask(h, { title: 'Immobile', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      const card = (await screen.findByRole('button', { name: 'Immobile' })).closest('[data-drag-id]') as HTMLElement;
      stubLayout();
      pointer(card, 'pointerdown', { x: 250, y: 10 });
      pointer(window, 'pointermove', { x: 1500, y: 20 }); // à droite de la dernière colonne
      pointer(window, 'pointerup', { x: 1500, y: 20 });
      pointer(card, 'pointerdown', { x: 250, y: 10 });
      pointer(window, 'pointermove', { x: 350, y: 20 });
      fireEvent.keyDown(window, { key: 'Escape' });
      pointer(window, 'pointerup', { x: 350, y: 20 });
      expect(titlesOf('2026-09-30')).toEqual(['Immobile']);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('une tâche terminée se déplace et reste terminée (critère 7)', async () => {
      const task = await seedTask(h, { title: 'Faite', date: asLocalDate('2026-09-30') });
      await createTaskUseCases(h.container).complete(task.id);
      renderWeek(h.container);
      const card = (await screen.findByRole('button', { name: 'Faite' })).closest('[data-drag-id]') as HTMLElement;
      stubLayout();
      pointer(card, 'pointerdown', { x: 250, y: 10 });
      pointer(window, 'pointermove', { x: 450, y: 20 }); // vendredi
      pointer(window, 'pointerup', { x: 450, y: 20 });
      await waitFor(() => expect(titlesOf('2026-10-02')).toEqual(['Faite']));
      expect(await h.container.data.repos.tasks.getById(task.id)).toMatchObject({ date: '2026-10-02', status: 'done' });
    });

    it('déposer dans le même jour réordonne selon A-02 : repère d’insertion puis nouvel ordre (critère 10)', async () => {
      await seedTask(h, { title: 'A', date: asLocalDate('2026-09-30') });
      await seedTask(h, { title: 'B', date: asLocalDate('2026-09-30') });
      await seedTask(h, { title: 'C', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      const card = (await screen.findByRole('button', { name: 'C' })).closest('[data-drag-id]') as HTMLElement;
      stubLayout();
      pointer(card, 'pointerdown', { x: 250, y: 90 });
      pointer(window, 'pointermove', { x: 250, y: 5 }); // au-dessus de A
      await waitFor(() => expect(document.querySelector('[data-insert="before"]')).not.toBeNull());
      expect(screen.queryByText(/Déposer ici/)).not.toBeInTheDocument();
      pointer(window, 'pointerup', { x: 250, y: 5 });
      await waitFor(() => expect(titlesOf('2026-09-30')).toEqual(['C', 'A', 'B']));
      const stored = await h.container.data.repos.tasks.listForDay(asLocalDate('2026-09-30'), 'all');
      expect(stored.map((t) => t.title)).toEqual(['C', 'A', 'B']);
    });

    it('une routine et un événement ne sont pas déplaçables : ni prise, ni zone cible (critère 6)', async () => {
      const routine = {
        id: asEntityId<RoutineId>('70000000-0000-4000-8000-000000000302'),
        spaceId: SPACE_PRO_ID,
        title: 'Boire de l’eau',
        icon: null,
        time: asLocalTime('08:30'),
        paused: false,
        archived: false,
        deletedAt: null,
      } as unknown as Routine;
      const event = { id: 'ev-1', title: 'Point client', allDay: false, startTime: asLocalTime('10:00'), spaceId: null, calendarName: 'Google Agenda', icon: null };
      off.push(
        registerTodaySource({
          id: 'week-test',
          load: (_container, date) => Promise.resolve(date === '2026-09-30' ? { routines: [{ routine, done: false }], events: [event] } : {}),
        }),
      );
      await seedTask(h, { title: 'Tâche', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      await screen.findByText('Boire de l’eau');
      stubLayout();
      for (const label of ['Boire de l’eau', 'Point client']) {
        const element = screen.getByText(new RegExp(label));
        expect(element.closest('[data-drag-id]')).toBeNull();
        pointer(element, 'pointerdown', { x: 250, y: 10 });
        pointer(window, 'pointermove', { x: 350, y: 20 });
        expect(screen.queryByText(/Déposer ici/)).not.toBeInTheDocument();
        pointer(window, 'pointerup', { x: 350, y: 20 });
      }
      expect(titlesOf('2026-10-01')).toEqual([]);
    });
  });

  describe('toucher sur iPhone (critère 4)', () => {
    beforeEach(() => mockViewport(440));

    it('un appui long saisit la ligne sans ouvrir la fiche, le lâcher sur une autre section la déplace', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await seedTask(h, { title: 'Envoyer la facture', date: asLocalDate('2026-09-30'), time: '09:00' });
        renderWeek(h.container);
        await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Envoyer la facture' })).toBeInTheDocument(), { timeout: 3000 });
        const card = screen.getByRole('button', { name: 'Envoyer la facture' }).closest('[data-drag-id]') as HTMLElement;
        stubLayout();
        pointer(card, 'pointerdown', { x: 250, y: 10, touch: true });
        act(() => {
          vi.advanceTimersByTime(450);
        });
        expect(screen.getByText('Envoyer la facture', { selector: '.ct-drag-ghost__title' })).toBeInTheDocument();
        pointer(window, 'pointermove', { x: 350, y: 20, touch: true });
        pointer(window, 'pointerup', { x: 350, y: 20, touch: true });
        await vi.waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Envoyer la facture']), { timeout: 3000 });
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('un simple toucher ouvre la fiche détail (Q16)', async () => {
      await seedTask(h, { title: 'À ouvrir', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'À ouvrir' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });
  });
});
