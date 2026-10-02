import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : ven. 2 oct. 2026, semaine ISO 40 (28 sept. au 4 oct.). */
const ctrl = (k: 'ArrowLeft' | 'ArrowRight', editable = false): KeyInput => ({ key: k, code: k, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable });
const day = (iso: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-date="${iso}"]`);
const dates = (): (string | null)[] => [...document.querySelectorAll('.ct-week-day')].map((el) => el.getAttribute('data-date'));
const heading = (): string => screen.getByRole('heading', { level: 1 }).textContent ?? '';
const live = (): string => [...document.querySelectorAll('[aria-live="polite"]')].map((el) => el.textContent ?? '').join('|');

describe('Semaine : navigation entre semaines (S-03)', () => {
  let h: WeekHarness;
  beforeEach(async () => {
    h = await setupWeek('303');
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
  });

  describe('PC', () => {
    beforeEach(() => mockViewport(1440));

    it('« Semaine suivante » affiche la semaine 41, « Semaine précédente » la 39 (critère 1)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      expect(await screen.findByText('Semaine 41')).toBeInTheDocument();
      expect(heading()).toBe('5 – 11 octobre 2026');
      expect(dates()).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);

      fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      expect(await screen.findByText('Semaine 39')).toBeInTheDocument();
      expect(heading()).toBe('21 – 27 septembre 2026');
    });

    it('Ctrl+→ / Ctrl+← changent de semaine hors champ de saisie, pas dans un champ (critère 2)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      act(() => {
        h.container.shortcuts.handle(ctrl('ArrowRight'));
      });
      expect(await screen.findByText('Semaine 41')).toBeInTheDocument();
      act(() => {
        h.container.shortcuts.handle(ctrl('ArrowLeft', true)); // dans un champ de saisie : ignoré
      });
      expect(screen.getByText('Semaine 41')).toBeInTheDocument();
      act(() => {
        h.container.shortcuts.handle(ctrl('ArrowLeft'));
      });
      expect(await screen.findByText('Semaine 40')).toBeInTheDocument();
    });

    it('Ctrl+→ est ignoré sous une fenêtre modale (la saisie en cours n’est pas perdue)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      const modal = document.createElement('div');
      modal.setAttribute('aria-modal', 'true');
      document.body.append(modal);
      try {
        act(() => {
          h.container.shortcuts.handle(ctrl('ArrowRight'));
        });
        expect(screen.getByText('Semaine 40')).toBeInTheDocument();
      } finally {
        modal.remove();
      }
    });

    it('« Cette semaine » est inactive dans la semaine courante, active ailleurs, et y ramène (critère 4)', async () => {
      renderWeek(h.container);
      const pill = await screen.findByRole('button', { name: 'Cette semaine' });
      expect(pill).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(pill);
      expect(screen.getByText('Semaine 40')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      await screen.findByText('Semaine 41');
      expect(pill).toHaveAttribute('aria-disabled', 'false');
      fireEvent.click(pill);
      expect(await screen.findByText('Semaine 40')).toBeInTheDocument();
      expect(pill).toHaveAttribute('aria-disabled', 'true');
      expect(day('2026-10-02')).toHaveAttribute('data-today', 'true');
    });

    it('depuis une semaine passée, « Cette semaine » revient aussi à la semaine courante', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      await screen.findByText('Semaine 37');
      fireEvent.click(screen.getByRole('button', { name: 'Cette semaine' }));
      expect(await screen.findByText('Semaine 40')).toBeInTheDocument();
    });

    it('le passage d’année est correct : semaine 53 de 2026 puis semaine 1 de 2027 (critère 5)', async () => {
      await teardownWeek(h);
      h = await setupWeek('304', '2026-12-29T10:00:00.000Z');
      renderWeek(h.container);
      await screen.findByText('Semaine 53');
      expect(heading()).toBe('28 décembre 2026 – 3 janvier 2027');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      expect(await screen.findByText('Semaine 1')).toBeInTheDocument();
      expect(heading()).toBe('4 – 10 janvier 2027');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      expect(await screen.findByText('Semaine 53')).toBeInTheDocument();
    });

    it('chaque semaine affiche ses tâches ; le filtre d’espace est conservé d’une semaine à l’autre', async () => {
      await seedTask(h, { title: 'Tâche courante', date: asLocalDate('2026-10-01') });
      await seedTask(h, { title: 'Semaine prochaine pro', date: asLocalDate('2026-10-06') });
      await seedTask(h, { title: 'Semaine prochaine perso', date: asLocalDate('2026-10-07'), spaceId: SPACE_PERSO_ID });
      renderWeek(h.container);
      expect(await screen.findByText('Tâche courante', { selector: '.ct-week-item__title' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      expect(await screen.findByText('Semaine prochaine pro')).toBeInTheDocument();
      expect(screen.getByText('Semaine prochaine perso')).toBeInTheDocument();
      expect(screen.queryByText('Tâche courante', { selector: '.ct-week-item__title' })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
      await waitFor(() => expect(screen.queryByText('Semaine prochaine pro')).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      await screen.findByText('Semaine 40');
      expect(useAppStore.getState().spaceFilter).toBe(SPACE_PERSO_ID);
      expect(screen.queryByText('Tâche courante', { selector: '.ct-week-item__title' })).not.toBeInTheDocument();
    });

    it('la dernière semaine consultée revient dans la session ; au redémarrage, la semaine courante (critère 7)', async () => {
      const { unmount } = renderWeek(h.container);
      await screen.findByText('Semaine 40');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      await screen.findByText('Semaine 41');
      unmount();

      // Quitter la Semaine pour un autre onglet, puis y revenir (Alt+2) : la semaine 41 est restaurée.
      act(() => useNavigationStore.getState().goToTab('routines'));
      act(() => useNavigationStore.getState().goToTab('week'));
      renderWeek(h.container);
      expect(await screen.findByText('Semaine 41')).toBeInTheDocument();

      // Redémarrage : l'état de navigation repart de zéro.
      act(() => useNavigationStore.setState(INITIAL_NAVIGATION));
      expect(await screen.findByText('Semaine 40')).toBeInTheDocument();
    });

    it('annonce le changement aux lecteurs d’écran, flèches nommées (critère 8)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      expect(live()).toContain('Semaine 40, 28 sept. – 4 oct.');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      await screen.findByText('Semaine 41');
      expect(live()).toContain('Semaine 41, 5 – 11 oct.');
      expect(screen.getByRole('button', { name: 'Semaine précédente' })).toBeInTheDocument();
    });

    it('le glissement de la grille est indiqué par le sens du changement (animation neutralisée par « Réduire les animations »)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      expect(document.querySelector('.ct-week__days')).not.toHaveAttribute('data-direction');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      await screen.findByText('Semaine 41');
      expect(document.querySelector('.ct-week__days')).toHaveAttribute('data-direction', 'next');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      await screen.findByText('Semaine 40');
      expect(document.querySelector('.ct-week__days')).toHaveAttribute('data-direction', 'previous');
    });

    it('un échec de chargement d’une semaine n’empêche pas de naviguer vers une autre', async () => {
      const original = h.container.data.repos.tasks.listForWeek.bind(h.container.data.repos.tasks);
      h.container.data.repos.tasks.listForWeek = (weekStart, filter) => (weekStart === '2026-10-05' ? Promise.reject(new Error('boom')) : original(weekStart, filter));
      renderWeek(h.container);
      await screen.findByText('Semaine 40');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger la semaine.');
      fireEvent.click(screen.getByRole('button', { name: 'Semaine précédente' }));
      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(dates()[0]).toBe('2026-09-28');
    });
  });

  describe('iPhone', () => {
    beforeEach(() => mockViewport(440));

    function swipe(zone: HTMLElement, from: [number, number], to: [number, number], ms: number): void {
      zone.getBoundingClientRect = () => ({ width: 360, height: 700, top: 0, left: 0, right: 360, bottom: 700, x: 0, y: 0, toJSON: () => ({}) });
      const fire = (type: string, point: [number, number], at: number): void => {
        const event = new MouseEvent(type, { bubbles: true, clientX: point[0], clientY: point[1] });
        Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'touch' }, timeStamp: { value: 1000 + at } });
        act(() => {
          zone.dispatchEvent(event);
        });
      };
      fire('pointerdown', from, 0);
      fire('pointermove', to, ms / 2);
      fire('pointerup', to, ms);
    }

    it('un balayage vers la gauche affiche la semaine suivante, vers la droite la précédente (critère 3)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40 · 2026');
      const zone = (): HTMLElement => document.querySelector('.ct-week__days') as HTMLElement;
      swipe(zone(), [300, 400], [60, 410], 300);
      expect(await screen.findByText('Semaine 41 · 2026')).toBeInTheDocument();
      expect(heading()).toBe('5 – 11 oct.');
      swipe(zone(), [40, 400], [300, 395], 300);
      expect(await screen.findByText('Semaine 40 · 2026')).toBeInTheDocument();
    });

    it('un défilement vertical ou un geste trop court ne change pas de semaine (critère 3)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40 · 2026');
      const zone = document.querySelector('.ct-week__days') as HTMLElement;
      swipe(zone, [200, 650], [230, 80], 200);
      swipe(zone, [200, 400], [170, 400], 900);
      expect(screen.getByText('Semaine 40 · 2026')).toBeInTheDocument();
    });

    it('les flèches sont à droite du titre et « Cette semaine » à droite des pastilles (maquette iPhone)', async () => {
      renderWeek(h.container);
      await screen.findByText('Semaine 40 · 2026');
      expect(document.querySelector('.ct-week__headerRow .ct-week__arrows')).not.toBeNull();
      expect(document.querySelector('.ct-week__pillsRow .ct-week__pill')).toHaveTextContent('Cette semaine');
    });
  });
});
