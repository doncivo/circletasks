import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import { asLocalDate, type GoalId, type RoutineId } from '../../domain/types';
import type { KeyInput } from '../app/shortcuts';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { RoutinesScreen } from '../routines/RoutinesScreen';
import { seedLog, seedRoutine } from '../routines/testKit';
import { TaskDetail } from '../tasks/TaskDetail';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { seedProject } from './testKit';

const CTRL_Z: KeyInput = { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false };

describe('Déplacer un élément d’un espace ou projet à l’autre (ES-05)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('e5009');
  });
  afterEach(async () => {
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await teardownToday(h);
  });

  const select = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Sélectionner : ${title}` }));
  const stored = async (title: string) => (await h.container.data.repos.tasks.listForDay(h.today, 'all')).find((task) => task.title === title);

  describe('par lot (mode édition, Q12)', () => {
    async function openBatch() {
      mockViewport(440);
      const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
      await seedProject(h, SPACE_PERSO_ID, 'Maison');
      const a = await seedTask(h, { title: 'A', time: '09:00' });
      const b = await seedTask(h, { title: 'B', time: '10:00' });
      await h.container.data.repos.tasks.update(a.id, { projectId: mission.id });
      renderToday(h.container);
      await screen.findByRole('button', { name: 'A' });
      fireEvent.click(screen.getByRole('button', { name: 'Mode édition' }));
      select('A');
      select('B');
      fireEvent.click(screen.getByRole('button', { name: 'Déplacer' }));
      const dialog = await screen.findByRole('alertdialog');
      return { dialog, mission, a, b };
    }

    it('propose espace puis projet, ou aucun projet, en une liste (critère 4, Q12)', async () => {
      const { dialog } = await openBatch();
      expect(dialog).toHaveAccessibleName('Déplacer vers un espace ou un projet');
      const labels = within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent);
      expect(labels).toEqual(['Pro · aucun projet', 'Pro · Mission client', 'Perso · aucun projet', 'Perso · Maison', 'Annuler']);
    });

    it('« Perso · aucun projet » : 2 tâches en une action, date inchangée, projet remis à aucun, message avec « Annuler » (critères 1, 4, 5, 7)', async () => {
      const { dialog, mission, a } = await openBatch();
      expect((await stored('A'))?.projectId).toBe(mission.id);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Perso · aucun projet' }));
      await waitFor(async () => expect((await stored('A'))?.spaceId).toBe(SPACE_PERSO_ID));
      const [moved, other] = [await stored('A'), await stored('B')];
      expect(moved).toMatchObject({ spaceId: SPACE_PERSO_ID, projectId: null, date: h.today, time: '09:00' });
      expect(other).toMatchObject({ spaceId: SPACE_PERSO_ID, projectId: null, date: h.today, time: '10:00' });
      expect(await screen.findByRole('status')).toHaveTextContent('2 tâches déplacées dans Perso');
      expect(h.container.undo.getSnapshot().size).toBe(1);

      // « Annuler » restaure espace ET projet d'origine de chaque élément.
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect((await stored('A'))?.spaceId).toBe(SPACE_PRO_ID));
      expect(await stored('A')).toMatchObject({ spaceId: SPACE_PRO_ID, projectId: a.projectId ?? mission.id });
      expect(await stored('B')).toMatchObject({ spaceId: SPACE_PRO_ID, projectId: null });
    });

    it('« Pro · Mission client » : un autre projet du même espace ; Ctrl+Z annule (critères 2, 5)', async () => {
      const { dialog, mission } = await openBatch();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Pro · Mission client' }));
      await waitFor(async () => expect((await stored('B'))?.projectId).toBe(mission.id));
      expect(await stored('B')).toMatchObject({ spaceId: SPACE_PRO_ID, projectId: mission.id });
      expect(await screen.findByRole('status')).toHaveTextContent('« B » déplacée dans Pro · Mission client');
      act(() => void h.container.shortcuts.handle(CTRL_Z));
      await waitFor(async () => expect((await stored('B'))?.projectId).toBeNull());
    });

    it('filtre Pro : la tâche déplacée dans Perso quitte la liste aussitôt (critère 6)', async () => {
      mockViewport(440);
      await seedTask(h, { title: 'A', time: '09:00' });
      await seedTask(h, { title: 'B', time: '10:00' });
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
      renderToday(h.container);
      await screen.findByRole('button', { name: 'A' });
      fireEvent.click(screen.getByRole('button', { name: 'Mode édition' }));
      select('A');
      fireEvent.click(screen.getByRole('button', { name: 'Déplacer' }));
      fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Perso · aucun projet' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'A' })).toBeNull());
      expect(screen.getByRole('button', { name: 'B' })).toBeInTheDocument();
    });
  });

  describe('depuis la fiche détail', () => {
    async function openDetail() {
      mockViewport(1440);
      const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
      const goalId = newEntityId<GoalId>(h.container.ids);
      await h.container.data.repos.goals.create({ id: goalId, spaceId: SPACE_PRO_ID, weekStart: asLocalDate('2026-09-28'), title: 'Objectif', icon: null, pinned: false, status: 'open', carriedFromId: null });
      const created = await createTaskUseCases(h.container).create({ title: 'Envoyer la facture', spaceId: SPACE_PRO_ID, projectId: mission.id, goalId, date: h.today, time: '09:00' as never, reminderOffsets: [0, 15] });
      if (!created.ok) throw new Error('création impossible');
      useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
      render(
        <AppContainerProvider container={h.container}>
          <TaskDetail />
          <UndoToast />
        </AppContainerProvider>,
      );
      await screen.findByRole('complementary');
      return { task: created.value, mission, goalId };
    }

    it('choisir l’espace Perso : l’espace change, le projet devient « aucun » ; date, rappels, objectif et statut sont conservés ; annulable (critères 1, 5, 7)', async () => {
      const { task, goalId } = await openDetail();
      fireEvent.click(screen.getByRole('button', { name: 'Espace de la tâche : Pro' }));
      fireEvent.click(within(screen.getByRole('group', { name: 'Espace de la tâche' })).getByRole('button', { name: 'Perso' }));
      await waitFor(async () => expect((await h.container.data.repos.tasks.getById(task.id))?.spaceId).toBe(SPACE_PERSO_ID));
      const after = await h.container.data.repos.tasks.getById(task.id);
      expect(after).toMatchObject({ projectId: null, date: h.today, time: '09:00', goalId, status: 'todo' });
      expect((await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task.id })).map((r) => r.offsetMin).sort()).toEqual([0, 15]);
      expect(await screen.findByRole('status')).toHaveTextContent('« Envoyer la facture » déplacée dans Perso');
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect((await h.container.data.repos.tasks.getById(task.id))?.spaceId).toBe(SPACE_PRO_ID));
      expect((await h.container.data.repos.tasks.getById(task.id))?.projectId).toBe(task.projectId);
    });

    it('choisir un autre projet du même espace : seul le projet change (critère 2)', async () => {
      const { task } = await openDetail();
      const site = await seedProject(h, SPACE_PRO_ID, 'Refonte site');
      fireEvent.click(await screen.findByRole('button', { name: 'Projet : Mission client' }));
      fireEvent.change(screen.getByRole('combobox', { name: 'Projet' }), { target: { value: site.id } });
      await waitFor(async () => expect((await h.container.data.repos.tasks.getById(task.id))?.projectId).toBe(site.id));
      expect((await h.container.data.repos.tasks.getById(task.id))?.spaceId).toBe(SPACE_PRO_ID);
      expect(await screen.findByRole('status')).toHaveTextContent('déplacée dans Pro · Refonte site');
    });
  });

  describe('routine', () => {
    it('changer l’espace dans le formulaire déplace la routine et son historique (critère 3)', async () => {
      mockViewport(440);
      const routine = await seedRoutine(h, { title: 'Faire mon lit', spaceId: SPACE_PRO_ID });
      await seedLog(h, routine, '2026-09-30');
      await seedLog(h, routine, '2026-10-01');
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
      render(
        <AppContainerProvider container={h.container}>
          <RoutinesScreen />
          <UndoToast />
        </AppContainerProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Faire mon lit' }));
      const form = await screen.findByRole('form', { name: 'Modifier la routine' });
      fireEvent.click(within(form).getByRole('button', { name: 'Perso' }));
      fireEvent.click(within(form).getByRole('button', { name: 'Enregistrer' }));
      await waitFor(async () => expect((await h.container.data.repos.routines.listForFilter(SPACE_PERSO_ID)).map((r) => r.title)).toEqual(['Faire mon lit']));
      expect(await h.container.data.repos.routines.listForFilter(SPACE_PRO_ID)).toEqual([]);
      // L'historique suit la routine : mêmes validations, désormais lues sous Perso.
      const logs = await h.container.data.repos.routineLogs.listForRoutine(routine.id as RoutineId, { from: asLocalDate('2026-09-01'), to: asLocalDate('2026-10-31') });
      expect(logs.map((log) => log.date)).toEqual(['2026-09-30', '2026-10-01']);
      // Sous le filtre Pro, la carte a quitté la liste.
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Faire mon lit' })).toBeNull());
    });
  });

  it('le cas d’usage ignore un projet d’un autre espace et n’écrit rien si rien ne change (règle du domaine)', async () => {
    const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
    const task = await seedTask(h, { title: 'A' });
    const useCases = createTaskUseCases(h.container);
    // Projet de Pro demandé avec l'espace Perso : la tâche passe dans Perso sans projet.
    const [moved] = await useCases.moveToSpace([task.id], SPACE_PERSO_ID, mission.id);
    expect(moved).toMatchObject({ spaceId: SPACE_PERSO_ID, projectId: null });
    expect(await useCases.moveToSpace([task.id], SPACE_PERSO_ID, null)).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(1);
  });
});
