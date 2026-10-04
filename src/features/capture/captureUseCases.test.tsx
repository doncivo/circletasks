import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import { addDays } from '../../domain/localDate';
import { tokenKey } from '../../domain/quickInput';
import type { Task } from '../../domain/model';
import type { ProjectId } from '../../domain/types';
import { undoMessage } from '../app/undo';
import { useAppStore } from '../app/appStore';
import { setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { createTaskFromCaptureText } from './captureUseCases';

/** Création depuis le texte de la mini-fenêtre (Q-01 critères 2, 5, 9) : mêmes règles que le champ d'Aujourd'hui. */
describe('création depuis la mini-fenêtre (Q-01)', () => {
  let h: TodayHarness;
  let missionId: ProjectId;

  beforeEach(async () => {
    h = await setupToday('b101');
    const mission = await h.container.data.repos.projects.create({
      id: newEntityId<ProjectId>(h.container.ids),
      spaceId: SPACE_PRO_ID,
      name: 'Mission',
      color: '#2F6B7A' as never,
      archived: false,
      sortOrder: 1,
    });
    missionId = mission.id;
    useAppStore.getState().setProjects([mission]);
  });
  afterEach(() => teardownToday(h));

  const all = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];
  const create = (text: string, ignored: readonly string[] = []) => createTaskFromCaptureText(h.container, text, ignored);

  it('« Appeler le notaire demain 10h #pro » : titre, date, heure et espace (critère 2)', async () => {
    const result = await create('Appeler le notaire demain 10h #pro');
    expect(result.ok).toBe(true);
    const [task] = await all();
    expect(task).toMatchObject({ title: 'Appeler le notaire', spaceId: SPACE_PRO_ID, date: addDays(h.today, 1), time: '10:00', status: 'todo' });
    expect(h.container.taskEntities.get(task?.id as never)).toBeDefined();
  });

  it('sans date écrite, la tâche est datée d’aujourd’hui, dans l’espace par défaut (ES-02), sans heure', async () => {
    await create('Acheter du pain');
    const [task] = await all();
    expect(task).toMatchObject({ title: 'Acheter du pain', date: h.today, time: null, spaceId: SPACE_PRO_ID });
  });

  it('l’espace par défaut suit le filtre Perso ; une marque explicite l’emporte', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    await create('Ranger le garage');
    await create('Facturer le client #pro');
    const tasks = await all();
    expect(tasks.find((t) => t.title === 'Ranger le garage')?.spaceId).toBe(SPACE_PERSO_ID);
    expect(tasks.find((t) => t.title === 'Facturer le client')?.spaceId).toBe(SPACE_PRO_ID);
  });

  it('« @mission » donne le projet et son espace (Q-06)', async () => {
    await create('Écrire le devis @mission');
    const [task] = await all();
    expect(task).toMatchObject({ title: 'Écrire le devis', spaceId: SPACE_PRO_ID, projectId: missionId });
  });

  it('les marques retirées de l’aperçu restent dans le titre', async () => {
    const key = tokenKey('space', '#pro');
    await create('Parler de #pro', [key]);
    const [task] = await all();
    expect(task?.title).toBe('Parler de #pro');
  });

  it('une heure dictée en lettres est lue (Q-03)', async () => {
    await create('appeler le plombier demain neuf heures trente');
    const [task] = await all();
    expect(task).toMatchObject({ title: 'appeler le plombier', date: addDays(h.today, 1), time: '09:30' });
  });

  it('une heure fait créer les rappels par défaut des réglages', async () => {
    await create('Réunion équipe demain 14h');
    const [task] = await all();
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task?.id as never });
    const defaults = await h.container.data.repos.settings.get('reminders.defaultOffsets');
    expect(reminders.length).toBe(defaults.length);
  });

  it('un titre vide est refusé sans rien écrire (T-01)', async () => {
    expect(await create('   ')).toEqual({ ok: false, error: 'title-empty' });
    expect(await create('#pro')).toEqual({ ok: false, error: 'title-empty' });
    expect(await all()).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });

  it('sans espace chargé : « no-space », rien n’est écrit', async () => {
    useAppStore.getState().setSpaces([]);
    expect(await create('Appeler')).toEqual({ ok: false, error: 'no-space' });
    expect(await all()).toEqual([]);
  });

  it('un titre trop long est refusé sans planter', async () => {
    const result = await create('x'.repeat(400));
    expect(result.ok).toBe(false);
    expect(await all()).toEqual([]);
  });

  it('« Annuler » (5 s) et Ctrl+Z retirent la tâche et ses rappels ; « Ajouté dans Perso » sous le filtre Pro (critère 5)', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    await create('Réserver le dentiste #perso demain 9h');
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('Ajouté dans Perso');
    const [task] = await all();
    expect(task?.spaceId).toBe(SPACE_PERSO_ID);

    const result = await h.container.undo.undoLast();
    expect(result.status).toBe('undone');
    expect(await all()).toEqual([]);
    expect(h.container.taskEntities.get(task?.id as never)).toBeUndefined();
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'task', id: task?.id as never })).toEqual([]);
  });

  it('dans l’espace visible, le message dit « « Titre » ajoutée »', async () => {
    await create('Payer la cantine');
    const top = h.container.undo.getSnapshot().top;
    expect(top && undoMessage(top)).toBe('« Payer la cantine » ajoutée');
  });

  it('une tâche modifiée depuis ne peut plus être annulée : « stale », rien n’est écrit', async () => {
    await create('Payer la cantine');
    const [task] = await all();
    await h.container.data.repos.tasks.update(task?.id as never, { note: 'modifiée' });
    expect((await h.container.undo.undoLast()).status).toBe('stale');
    expect(await all()).toHaveLength(1);
  });
});
