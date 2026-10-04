import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import { asLocalDate, type ProjectId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { seedSomeday } from '../someday/testKit';
import { mockViewport, renderWeek, seedTask, setupWeek, teardownWeek, type WeekHarness } from './testKit';

/** Aujourd'hui du harnais : ven. 2 oct. 2026 (semaine du lundi 28 sept. au dimanche 4 oct.). */
const day = (iso: string): HTMLElement => document.querySelector<HTMLElement>(`[data-date="${iso}"]`) as HTMLElement;
const titlesOf = (iso: string): string[] => [...day(iso).querySelectorAll('.ct-week-item__title')].map((el) => el.textContent ?? '');
const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Un jour' });
const panelTitles = (): string[] => [...panel().querySelectorAll('.ct-list-row__title')].map((el) => el.textContent ?? '');
const card = (title: string): HTMLElement => within(panel()).getByRole('button', { name: title }).closest('[data-drag-id]') as HTMLElement;
const openPanel = (): void => {
  act(() => useNavigationStore.getState().navigate({ tab: 'week', weekStart: null, somedayPanel: true }));
};

function pointer(target: EventTarget, type: string, init: { x?: number; y?: number } = {}): void {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x ?? 10, clientY: init.y ?? 10, button: 0 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Mise en page simulée : sept colonnes de 100 px (x < 700), panneau « Un jour » à droite (x ≥ 800) ; chaque carte fait 40 px de haut. */
function stubLayout(): void {
  const dates = [...document.querySelectorAll<HTMLElement>('.ct-week-day')].map((el) => el.dataset['date'] ?? '');
  document.elementsFromPoint = (x: number) => {
    if (x >= 800) return [panel()];
    const date = dates[Math.floor(x / 100)];
    return date ? [day(date)] : [document.body];
  };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const zone = this.closest('[data-drop-zone]');
    const slots = [...(zone?.querySelectorAll('[data-drag-id]') ?? [])];
    const index = slots.indexOf(this);
    const top = index < 0 ? 0 : index * 40;
    return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40, x: 0, y: top, toJSON: () => ({}) };
  });
}

describe('Semaine : panneau « Un jour » (S-06, PC)', () => {
  let h: WeekHarness;

  beforeEach(async () => {
    h = await setupWeek('461');
    mockViewport(1440);
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownWeek(h);
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  describe('ouverture et fermeture (critères 1, 2 et 7)', () => {
    it('le bouton « Un jour » de l’en-tête affiche le panneau à droite de la grille, qui garde ses sept jours', async () => {
      await seedSomeday(h, { title: 'Renouveler le passeport' });
      renderWeek(h.container);
      const button = await screen.findByRole('button', { name: 'Un jour, 1 tâche' });
      expect(button).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByRole('complementary', { name: 'Un jour' })).toBeNull();
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(panel()).toBeInTheDocument();
      expect(document.querySelectorAll('.ct-week-day')).toHaveLength(7);
      expect(screen.getByText('Glissez une tâche vers un jour pour la planifier.')).toBeInTheDocument();
      expect(within(panel()).getByRole('button', { name: 'Renouveler le passeport' })).toBeInTheDocument();
    });

    it('« Fermer le panneau » et Échap le ferment ; Échap ferme d’abord la fiche ouverte', async () => {
      const task = await seedSomeday(h, { title: 'Renouveler le passeport' });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour, 1 tâche' });
      openPanel();
      fireEvent.click(within(panel()).getByRole('button', { name: 'Fermer le panneau' }));
      expect(screen.queryByRole('complementary', { name: 'Un jour' })).toBeNull();

      openPanel();
      expect(panel()).toBeInTheDocument();
      act(() => {
        h.container.shortcuts.handle({ key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false });
      });
      expect(screen.queryByRole('complementary', { name: 'Un jour' })).toBeNull();

      // Avec une fiche ouverte, Échap est celui de la fiche : le panneau reste.
      openPanel();
      act(() => useNavigationStore.getState().openDetail({ type: 'task', id: task.id }));
      act(() => {
        h.container.shortcuts.handle({ key: 'Escape', code: 'Escape', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false });
      });
      expect(panel()).toBeInTheDocument();
    });

    it('l’état ouvert est conservé pendant la session : changer d’onglet puis revenir', async () => {
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour' });
      openPanel();
      expect(panel()).toBeInTheDocument();
      act(() => useNavigationStore.getState().goToTab('routines'));
      act(() => useNavigationStore.getState().goToTab('week'));
      expect(useNavigationStore.getState().route).toMatchObject({ tab: 'week', somedayPanel: true });
      // La navigation entre semaines garde aussi le panneau.
      fireEvent.click(screen.getByRole('button', { name: 'Semaine suivante' }));
      expect(useNavigationStore.getState().route).toMatchObject({ tab: 'week', somedayPanel: true });
    });
  });

  describe('contenu (critère 2)', () => {
    it('liste les tâches non terminées du filtre actif, dans l’ordre de SD-04, avec espace et projet', async () => {
      const project = await h.container.data.repos.projects.create({
        id: newEntityId<ProjectId>(h.container.ids),
        spaceId: SPACE_PRO_ID,
        name: 'Mission client',
        color: '#2F6B7A' as never,
        archived: false,
        sortOrder: 1,
      });
      useAppStore.getState().setProjects([project]);
      await seedSomeday(h, { title: 'Réparer l’étagère', spaceId: SPACE_PERSO_ID });
      await seedSomeday(h, { title: 'Préparer la présentation Q4', projectId: project.id });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour, 2 tâches' });
      openPanel();
      expect(panelTitles()).toEqual(['Préparer la présentation Q4', 'Réparer l’étagère']);
      expect(card('Préparer la présentation Q4')).toHaveTextContent('Pro · Mission client');
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
      await waitFor(() => expect(panelTitles()).toEqual(['Réparer l’étagère']));
    });
  });

  describe('glisser vers un jour (critères 3 à 5)', () => {
    it('« Déposer ici · jeu. 1 » au survol ; au lâcher la tâche quitte le panneau et est datée ce jour, sans heure ; Annuler la remet à sa place', async () => {
      await seedSomeday(h, { title: 'Dernière' });
      const task = await seedSomeday(h, { title: 'Préparer la présentation Q4' });
      await seedSomeday(h, { title: 'Première' });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour, 3 tâches' });
      openPanel();
      expect(panelTitles()).toEqual(['Première', 'Préparer la présentation Q4', 'Dernière']);
      stubLayout();
      pointer(card('Préparer la présentation Q4'), 'pointerdown', { x: 900, y: 50 });
      pointer(window, 'pointermove', { x: 350, y: 20 }); // colonne du jeudi 1er oct.
      await waitFor(() => expect(screen.getByText('Déposer ici · jeu. 1')).toBeInTheDocument());
      pointer(window, 'pointerup', { x: 350, y: 20 });

      await waitFor(() => expect(titlesOf('2026-10-01')).toEqual(['Préparer la présentation Q4']));
      expect(panelTitles()).toEqual(['Première', 'Dernière']);
      expect(await h.container.data.repos.tasks.getById(task.id)).toMatchObject({ someday: false, date: '2026-10-01', time: null, spaceId: SPACE_PRO_ID });
      expect(screen.queryByText(/Déposer ici/)).toBeNull();
      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent('« Préparer la présentation Q4 » planifiée au jeu. 1 oct.');

      fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
      await waitFor(() => expect(panelTitles()).toEqual(['Première', 'Préparer la présentation Q4', 'Dernière']));
      expect(titlesOf('2026-10-01')).toEqual([]);
      expect(await h.container.data.repos.tasks.getById(task.id)).toMatchObject({ someday: true, date: null });
    });

    it('Ctrl+Z renvoie aussi la tâche dans « Un jour »', async () => {
      const task = await seedSomeday(h, { title: 'Préparer la présentation Q4' });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour, 1 tâche' });
      openPanel();
      stubLayout();
      pointer(card('Préparer la présentation Q4'), 'pointerdown', { x: 900, y: 10 });
      pointer(window, 'pointermove', { x: 250, y: 20 });
      pointer(window, 'pointerup', { x: 250, y: 20 });
      await waitFor(() => expect(titlesOf('2026-09-30')).toEqual(['Préparer la présentation Q4']));
      act(() => {
        h.container.shortcuts.handle({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false });
      });
      await waitFor(async () => expect(await h.container.data.repos.tasks.getById(task.id)).toMatchObject({ someday: true }));
      await waitFor(() => expect(panelTitles()).toEqual(['Préparer la présentation Q4']));
    });

    it('un lâcher hors de la grille, ou Échap, ne change rien (critère 5)', async () => {
      await seedSomeday(h, { title: 'Immobile' });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour, 1 tâche' });
      openPanel();
      stubLayout();
      pointer(card('Immobile'), 'pointerdown', { x: 900, y: 10 });
      pointer(window, 'pointermove', { x: 1400, y: 300 }); // hors de la grille et du panneau
      pointer(window, 'pointerup', { x: 1400, y: 300 });
      pointer(card('Immobile'), 'pointerdown', { x: 900, y: 10 });
      pointer(window, 'pointermove', { x: 350, y: 20 });
      fireEvent.keyDown(window, { key: 'Escape' });
      pointer(window, 'pointerup', { x: 350, y: 20 });
      expect(panelTitles()).toEqual(['Immobile']);
      for (const column of document.querySelectorAll<HTMLElement>('.ct-week-day')) expect(titlesOf(column.dataset['date'] ?? '')).toEqual([]);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('lâcher dans le panneau réordonne les cartes (SD-04) ; une carte datée lâchée sur le panneau ne bouge pas', async () => {
      await seedSomeday(h, { title: 'C' });
      await seedSomeday(h, { title: 'B' });
      await seedSomeday(h, { title: 'A' });
      const dated = await seedTask(h, { title: 'Datée', date: asLocalDate('2026-09-30') });
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour, 3 tâches' });
      openPanel();
      expect(panelTitles()).toEqual(['A', 'B', 'C']);
      stubLayout();
      pointer(card('C'), 'pointerdown', { x: 900, y: 90 });
      pointer(window, 'pointermove', { x: 900, y: 10 }); // au-dessus de la première carte
      pointer(window, 'pointerup', { x: 900, y: 10 });
      await waitFor(() => expect(panelTitles()).toEqual(['C', 'A', 'B']));

      pointer(screen.getByRole('button', { name: 'Datée' }).closest('[data-drag-id]') as HTMLElement, 'pointerdown', { x: 250, y: 10 });
      pointer(window, 'pointermove', { x: 900, y: 50 });
      pointer(window, 'pointerup', { x: 900, y: 50 });
      await act(async () => undefined);
      expect(await h.container.data.repos.tasks.getById(dated.id)).toMatchObject({ someday: false, date: '2026-09-30' });
      expect(panelTitles()).toEqual(['C', 'A', 'B']);
    });
  });

  describe('ajout (critère 6)', () => {
    it('« + Ajouter à « Un jour » » crée une tâche sans date, visible dans le panneau', async () => {
      renderWeek(h.container);
      await screen.findByRole('button', { name: 'Un jour' });
      openPanel();
      fireEvent.click(within(panel()).getByRole('button', { name: '+ Ajouter à « Un jour »' }));
      const field = within(panel()).getByRole('combobox', { name: 'Nouvelle tâche sans date' });
      fireEvent.change(field, { target: { value: 'Renouveler le passeport' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await waitFor(() => expect(panelTitles()).toEqual(['Renouveler le passeport']));
      const [created] = await h.container.data.repos.tasks.listSomeday('all');
      expect(created).toMatchObject({ someday: true, date: null, time: null });
    });
  });
});
