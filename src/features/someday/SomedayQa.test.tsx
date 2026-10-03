import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import { asLocalDate, type GoalId, type LocalTime } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { useNavigationStore } from '../app/navigation';
import { TaskDetail } from '../tasks/TaskDetail';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { renderToday } from '../today/testKit';
import { mockViewport, seedSomeday, setupSomeday, teardownSomeday, type SomedayHarness } from './testKit';

describe('Cas limites QA du lot « Un jour » (SD-01, SD-03, S-06)', () => {
  let h: SomedayHarness;

  beforeEach(async () => {
    h = await setupSomeday('491');
    mockViewport(440);
  });
  afterEach(() => teardownSomeday(h));

  it('SD-01 critère 6 : le badge plafonne à « 99+ » au-delà de 99 tâches', async () => {
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Un jour' });
    for (let n = 1; n <= 100; n += 1) await seedSomeday(h, { title: `T${String(n)}` });
    const button = await screen.findByRole('button', { name: 'Un jour, 100 tâches' });
    expect(within(button).getByText('99+')).toBeInTheDocument();
  });

  it('SD-01 critère 6 : 99 tâches affichent « 99 » exactement', async () => {
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Un jour' });
    for (let n = 1; n <= 99; n += 1) await seedSomeday(h, { title: `T${String(n)}` });
    const button = await screen.findByRole('button', { name: 'Un jour, 99 tâches' });
    expect(within(button).getByText('99')).toBeInTheDocument();
  });

  it('SD-03 critère 4 + OB-04 : une tâche d’un objectif envoyée dans « Un jour » reste rattachée et comptée dans l’avancement', async () => {
    const goalId = newEntityId<GoalId>(h.container.ids);
    await h.container.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart: asLocalDate('2026-09-28'),
      title: 'Finaliser le PRD',
      icon: { kind: 'emoji', value: '🎯' },
      pinned: true,
      status: 'open',
      carriedFromId: null,
    });
    const uc = createTaskUseCases(h.container);
    const a = await uc.create({ title: 'Relire', spaceId: SPACE_PRO_ID, date: h.today, goalId });
    const b = await uc.create({ title: 'Valider', spaceId: SPACE_PRO_ID, date: h.today, goalId });
    if (!a.ok || !b.ok) throw new Error('création');
    const progress = async () => (await h.container.data.repos.tasks.progressByGoal([goalId])).get(goalId);
    expect(await progress()).toEqual({ done: 0, total: 2 });

    await uc.moveToSomeday([a.value.id]);
    expect(await h.container.data.repos.tasks.getById(a.value.id)).toMatchObject({ someday: true, date: null, goalId });
    expect(await progress()).toEqual({ done: 0, total: 2 });

    await uc.complete(a.value.id);
    expect(await progress()).toEqual({ done: 1, total: 2 });
    expect((await h.container.data.repos.tasks.listByGoal(goalId)).map((t) => t.title).sort()).toEqual(['Relire', 'Valider']);
  });

  it('SD-02 critère 6 + OB-04 : planifier depuis « Un jour » garde le rattachement et l’avancement', async () => {
    const goalId = newEntityId<GoalId>(h.container.ids);
    await h.container.data.repos.goals.create({
      id: goalId,
      spaceId: SPACE_PRO_ID,
      weekStart: asLocalDate('2026-09-28'),
      title: 'Objectif',
      icon: { kind: 'emoji', value: '🎯' },
      pinned: true,
      status: 'open',
      carriedFromId: null,
    });
    const uc = createTaskUseCases(h.container);
    const created = await uc.create({ title: 'Tâche liée', spaceId: SPACE_PRO_ID, date: null, someday: true, goalId });
    if (!created.ok) throw new Error('création');
    await uc.scheduleSomeday([created.value.id], 'today');
    const stored = await h.container.data.repos.tasks.getById(created.value.id);
    expect(stored?.goalId).toBe(goalId);
    expect((await h.container.data.repos.tasks.progressByGoal([goalId])).get(goalId)).toEqual({ done: 0, total: 1 });
  });

  it('SD-03 critère 3 : « Un jour » puis Ctrl+Z (PC) restaure date, heure et position', async () => {
    mockViewport(1280);
    const created = await createTaskUseCases(h.container).create({ title: 'Appeler le notaire', spaceId: SPACE_PRO_ID, date: h.today, time: '10:00' as LocalTime });
    if (!created.ok) throw new Error('création');
    useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
        <UndoToast />
      </AppContainerProvider>,
    );
    await screen.findByText('Appeler le notaire');
    fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
    await waitFor(async () => expect(await h.container.data.repos.tasks.getById(created.value.id)).toMatchObject({ someday: true, date: null, time: null }));
    act(() => {
      h.container.shortcuts.handle({ key: 'z', code: 'KeyZ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false });
    });
    await waitFor(async () =>
      expect(await h.container.data.repos.tasks.getById(created.value.id)).toMatchObject({ someday: false, date: h.today, time: '10:00', sortOrder: created.value.sortOrder }),
    );
  });
});
