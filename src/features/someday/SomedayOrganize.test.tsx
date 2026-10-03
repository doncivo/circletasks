import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createHlcClock } from '../../domain/hlc';
import { newEntityId } from '../../domain/id';
import type { ProjectId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { createAppContainer } from '../app/container';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderSomeday, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

const keyInput = (key: string, over: Partial<KeyInput> = {}): KeyInput => ({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false, ...over });
const titles = (): string[] => Array.from(document.querySelectorAll('.ct-list-row__title')).map((node) => node.textContent ?? '');
const editSwitch = () => screen.getByRole('button', { name: 'Mode édition' });
/** Entrée d'un menu d'actions : menu déroulant sur PC (menuitem), feuille d'actions sur iPhone (button). */
const menuEntry = async (width: number, name: string) => screen.findByRole(width >= 1024 ? 'menuitem' : 'button', { name });
const select = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Sélectionner : ${title}` }));

describe.each([
  ['iPhone', 440],
  ['PC', 1280],
])('Organiser « Un jour » (SD-04), %s', (_name, width) => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday(width < 1024 ? '441' : '442');
    mockViewport(width);
  });
  afterEach(() => teardownSomeday(h));

  const stored = async () => (await h.container.data.repos.tasks.listSomeday('all')).map((task) => task.title);
  const get = async (title: string) => (await h.container.data.repos.tasks.listSomeday('all')).find((task) => task.title === title);

  async function openList(...names: string[]): Promise<void> {
    // La dernière créée est en tête : on crée à l'envers pour obtenir l'ordre donné.
    for (const title of [...names].reverse()) await seedSomeday(h, { title });
    renderSomeday(h.container);
    await screen.findByRole('button', { name: names[0] as string });
  }

  describe('réordonnancement (critère 1)', () => {
    it('la poignée déplace une tâche d’une position (↑ / ↓) ; l’ordre est enregistré et annulable', async () => {
      await openList('A', 'B', 'C');
      if (width < 1024) fireEvent.click(editSwitch()); // iPhone : les poignées sont celles du mode édition (Main-Edition.html)
      fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer : C' }), { key: 'ArrowUp' });
      await waitFor(async () => expect(await stored()).toEqual(['A', 'C', 'B']));
      expect(titles()).toEqual(['A', 'C', 'B']);
      expect(document.querySelector('[aria-live="polite"]:not(.ct-selection-bar__count)')).not.toBeNull();
      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent('Tâche déplacée');
      fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect(await stored()).toEqual(['A', 'B', 'C']));
    });

    it('Alt+↑ / Alt+↓ déplacent la ligne qui a le focus', async () => {
      await openList('A', 'B', 'C');
      act(() => screen.getByRole('button', { name: 'B' }).focus());
      act(() => {
        h.container.shortcuts.handle(keyInput('ArrowUp', { code: 'ArrowUp', altKey: true }));
      });
      await waitFor(async () => expect(await stored()).toEqual(['B', 'A', 'C']));
      act(() => {
        h.container.shortcuts.handle(keyInput('ArrowDown', { code: 'ArrowDown', altKey: true }));
      });
      await waitFor(async () => expect(await stored()).toEqual(['A', 'B', 'C']));
    });

    it('l’ordre est conservé après redémarrage (sort_order)', async () => {
      await openList('A', 'B', 'C');
      if (width < 1024) fireEvent.click(editSwitch());
      fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer : A' }), { key: 'ArrowDown' });
      await waitFor(async () => expect(await stored()).toEqual(['B', 'A', 'C']));
      cleanup();
      const restarted = createAppContainer({ clock: h.db.clock, hlc: createHlcClock({ clock: h.db.clock, deviceId: h.db.deviceId }), data: h.db.data });
      renderSomeday(restarted);
      await screen.findByRole('button', { name: 'B' });
      expect(titles()).toEqual(['B', 'A', 'C']);
    });
  });

  describe('filtre espace et projet (critères 3 et 4)', () => {
    it('le menu « Projet : tous » apparaît sous Pro avec un projet, se masque en Tout ; choisir un projet ne garde que ses tâches', async () => {
      const project = await h.container.data.repos.projects.create({
        id: newEntityId<ProjectId>(h.container.ids),
        spaceId: SPACE_PRO_ID,
        name: 'Mission client',
        color: '#2F6B7A' as never,
        archived: false,
        sortOrder: 1,
      });
      useAppStore.getState().setProjects([project]);
      await seedSomeday(h, { title: 'Sans projet' });
      await seedSomeday(h, { title: 'Dans le projet', projectId: project.id });
      await seedSomeday(h, { title: 'Perso', spaceId: SPACE_PERSO_ID });
      renderSomeday(h.container);
      // Le panneau PC n'a pas de pastilles : le menu est celui de l'en-tête d'Aujourd'hui / de la Semaine (ES-04), ici piloté par le filtre global.
      const phone = width < 1024;
      await screen.findByText('3 tâches sans date, à planifier plus tard');
      expect(screen.queryByRole('combobox', { name: 'Filtre de projet' })).toBeNull();

      act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
      expect(await screen.findByText('2 tâches sans date, à planifier plus tard')).toBeInTheDocument();
      if (phone) fireEvent.change(await screen.findByRole('combobox', { name: 'Filtre de projet' }), { target: { value: project.id } });
      else act(() => useAppStore.getState().setProjectFilter(project.id));
      expect(await screen.findByText('1 tâche sans date, à planifier plus tard')).toBeInTheDocument();
      expect(titles()).toEqual(['Dans le projet']);

      act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
      if (phone) await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Filtre de projet' })).toBeNull());
      expect(await screen.findByText('1 tâche sans date, à planifier plus tard')).toBeInTheDocument();
      expect(titles()).toEqual(['Perso']);
    });
  });

  describe('mode édition (critère 5)', () => {
    it('chaque ligne montre sélection, « − » et poignée (iPhone) ; l’interrupteur revient au mode normal', async () => {
      await openList('A', 'B');
      expect(editSwitch()).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('checkbox', { name: 'Terminer : A' })).toBeInTheDocument();
      fireEvent.click(editSwitch());
      expect(editSwitch()).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('checkbox', { name: 'Terminer : A' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Sélectionner : A' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Supprimer : A' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Déplacer : A' })).toBeInTheDocument();
      fireEvent.click(editSwitch());
      expect(screen.getByRole('checkbox', { name: 'Terminer : A' })).toBeInTheDocument();
    });

    it('la barre « N sélectionnées » propose Déplacer, Planifier et Supprimer ; Échap quitte le mode', async () => {
      await openList('A', 'B', 'C');
      fireEvent.click(editSwitch());
      expect(screen.queryByRole('toolbar', { name: 'Actions sur la sélection' })).toBeNull();
      select('A');
      select('B');
      const bar = screen.getByRole('toolbar', { name: 'Actions sur la sélection' });
      expect(within(bar).getByText('2 sélectionnées')).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Déplacer' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Planifier' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
      expect(within(bar).queryByRole('button', { name: 'Reporter' })).toBeNull();
      act(() => {
        h.container.shortcuts.handle(keyInput('Escape'));
      });
      await waitFor(() => expect(editSwitch()).toHaveAttribute('aria-pressed', 'false'));
      expect(screen.queryByRole('toolbar', { name: 'Actions sur la sélection' })).toBeNull();
    });

    it('une sélection ne survit pas à un changement de filtre', async () => {
      await seedSomeday(h, { title: 'Pro 1' });
      await seedSomeday(h, { title: 'Perso 1', spaceId: SPACE_PERSO_ID });
      renderSomeday(h.container);
      await screen.findByRole('button', { name: 'Pro 1' });
      fireEvent.click(editSwitch());
      select('Pro 1');
      expect(screen.getByRole('toolbar', { name: 'Actions sur la sélection' })).toBeInTheDocument();
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
      await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Actions sur la sélection' })).toBeNull());
      act(() => useAppStore.getState().setSpaceFilter('all'));
      await screen.findByRole('button', { name: 'Sélectionner : Pro 1' });
      expect(screen.getByRole('button', { name: 'Sélectionner : Pro 1' })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('Planifier par lot (critère 6)', () => {
    it('Demain s’applique à toutes les tâches sélectionnées, un seul message ; Annuler les remet', async () => {
      await openList('A', 'B', 'C');
      fireEvent.click(editSwitch());
      select('A');
      select('C');
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'Actions sur la sélection' })).getByRole('button', { name: 'Planifier' }));
      fireEvent.click(await menuEntry(width, 'Demain'));
      await waitFor(async () => expect(await stored()).toEqual(['B']));
      expect(titles()).toEqual(['B']);
      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent('2 tâches planifiées');
      const planned = await h.container.data.repos.tasks.listForDay('2026-10-03' as never, 'all');
      expect(planned.map((task) => task.title).sort()).toEqual(['A', 'C']);
      fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect(await stored()).toEqual(['A', 'B', 'C']));
    });

    it('Choisir une date ouvre le sélecteur et planifie la sélection à la date choisie', async () => {
      await openList('A', 'B');
      fireEvent.click(editSwitch());
      select('A');
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'Actions sur la sélection' })).getByRole('button', { name: 'Planifier' }));
      fireEvent.click(await menuEntry(width, 'Choisir une date'));
      const dialog = await screen.findByRole('dialog', { name: 'Choisir une date' });
      if (width >= 1024) fireEvent.change(within(dialog).getByRole('textbox', { name: 'Date' }), { target: { value: '9/10' } });
      else fireEvent.click(within(dialog).getByRole('button', { name: 'Demain' }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Planifier' }));
      await waitFor(async () => expect(await stored()).toEqual(['B']));
      const expected = width >= 1024 ? '2026-10-09' : '2026-10-03';
      expect((await h.container.data.repos.tasks.listForDay(expected as never, 'all')).map((task) => task.title)).toEqual(['A']);
    });
  });

  describe('Déplacer (critère 5, Q12)', () => {
    it('change l’espace sans changer la date ni la position : les tâches restent dans « Un jour »', async () => {
      await openList('A', 'B');
      fireEvent.click(editSwitch());
      select('A');
      select('B');
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'Actions sur la sélection' })).getByRole('button', { name: 'Déplacer' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Perso · aucun projet' }));
      await waitFor(async () => expect((await get('A'))?.spaceId).toBe(SPACE_PERSO_ID));
      expect(await get('B')).toMatchObject({ spaceId: SPACE_PERSO_ID, someday: true, date: null });
      expect(await stored()).toEqual(['A', 'B']);
      expect(await screen.findByRole('status')).toHaveTextContent('2 tâches déplacées dans Perso');
    });
  });

  describe('Supprimer (critère 8)', () => {
    it('« − » demande confirmation, envoie à la corbeille (30 jours) et se laisse annuler', async () => {
      await openList('A', 'B');
      const idOfA = (await get('A'))?.id ?? '';
      fireEvent.click(editSwitch());
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer : A' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('Supprimer « A » ?');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
      await waitFor(async () => expect(await stored()).toEqual(['B']));
      const trashed = await h.container.data.repos.tasks.getById(idOfA as never, { includeDeleted: true });
      expect(trashed?.deletedAt).not.toBeNull();
      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent('« A » supprimée');
      fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect(await stored()).toEqual(['A', 'B']));
    });

    it('plusieurs tâches : « Supprimer 2 tâches ? », un seul message, une seule annulation', async () => {
      await openList('A', 'B', 'C');
      fireEvent.click(editSwitch());
      select('A');
      select('B');
      fireEvent.click(within(screen.getByRole('toolbar', { name: 'Actions sur la sélection' })).getByRole('button', { name: 'Supprimer' }));
      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('Supprimer 2 tâches ?');
      expect(dialog).toHaveTextContent('30 jours');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
      await waitFor(async () => expect(await stored()).toEqual(['C']));
      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent('2 tâches supprimées');
      fireEvent.click(within(toast).getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect(await stored()).toEqual(['A', 'B', 'C']));
    });

    it('annuler la confirmation ne supprime rien', async () => {
      await openList('A');
      fireEvent.click(editSwitch());
      fireEvent.click(screen.getByRole('button', { name: 'Supprimer : A' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Annuler' }));
      await act(async () => undefined);
      expect(await stored()).toEqual(['A']);
    });
  });

  describe('vue compacte (critère 7)', () => {
    it('une ligne par tâche, espace et projet masqués ; choix mémorisé séparément d’Aujourd’hui', async () => {
      await openList('A', 'B');
      const toggle = () => screen.getByRole('button', { name: 'Vue compacte' });
      expect(toggle()).toHaveAttribute('aria-pressed', 'false');
      const row = () => screen.getByRole('button', { name: 'A' }).closest('.ct-list-row') as HTMLElement;
      expect(row().querySelector('.ct-list-row__subtitle')).toHaveTextContent('Pro');
      fireEvent.click(toggle());
      expect(toggle()).toHaveAttribute('aria-pressed', 'true');
      expect(row()).toHaveAttribute('data-compact', 'true');
      expect(row().querySelector('.ct-list-row__subtitle')).toBeNull();
      await waitFor(async () => expect(await h.container.data.repos.settings.get('view.compact')).toEqual({ today: false, routines: false, checklists: false, someday: true }));

      cleanup();
      const restarted = createAppContainer({ clock: h.db.clock, hlc: createHlcClock({ clock: h.db.clock, deviceId: h.db.deviceId }), data: h.db.data });
      renderSomeday(restarted);
      await screen.findByRole('button', { name: 'A' });
      await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'true'));
      fireEvent.click(toggle());
      expect(row().querySelector('.ct-list-row__subtitle')).not.toBeNull();
    });

    it('terminer et déployer fonctionnent en vue compacte', async () => {
      await openList('A', 'B');
      fireEvent.click(screen.getByRole('button', { name: 'Vue compacte' }));
      fireEvent.click(screen.getByRole('button', { name: 'A' }));
      expect(screen.getByRole('button', { name: 'Planifier demain : A' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: 'Terminer : B' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'B' })).toBeNull());
    });
  });
});
