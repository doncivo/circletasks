import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appleRemindersState, appleRemindersStore } from './appleRemindersState';
import { detachUnlisted, resetLists } from './appleListRepairs';
import { PERSO, setupRemindersHarness, type RemindersHarness } from './testKit';

/**
 * Réglage des listes illisible ou liste absente du réglage : jamais traités comme « décochée » (qui met des tâches à la corbeille).
 * La règle de la liste décochée ne vaut que pour une liste présente avec `shown: false`, et la garde de suppression massive s'y applique.
 */
let h: RemindersHarness;
beforeEach(async () => {
  h = await setupRemindersHarness('22');
  await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
});
afterEach(() => h.close());

const status = () => appleRemindersStore.get(h.container).getState().status;

async function importMany(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) h.reminders.add({ listId: 'L-courses', title: `Rappel ${String(index)}` });
  await h.pass();
}

describe('réglage des listes illisible ou liste absente (audit M1, revue 6)', () => {
  it('réglage malformé : passage interrompu avec échec visible, aucune tâche supprimée ni détachée', async () => {
    await importMany(3);
    await h.container.data.repos.settings.set('appleReminders.lists', 'illisible' as never);
    const report = await h.pass();
    expect(report).toMatchObject({ status: 'failed', code: 'lists-setting-invalid', deleted: 0, detached: 0 });
    const tasks = await h.tasks();
    expect(tasks).toHaveLength(3);
    expect(tasks.every((task) => task.source === 'apple_reminders' && task.externalId !== null && task.deletedAt === null)).toBe(true);
    expect(status().failure).toMatchObject({ code: 'lists-setting-invalid' });
  });

  it('liste absente du réglage (entrée disparue) : même refus, les tâches restent liées', async () => {
    await importMany(3);
    await h.container.data.repos.settings.set('appleReminders.lists', { lists: [] } as never);
    expect(await h.pass()).toMatchObject({ status: 'failed', code: 'lists-setting-invalid', deleted: 0, detached: 0 });
    expect((await h.tasks()).filter((task) => task.externalId !== null)).toHaveLength(3);
    // Réglage rétabli : le passage suivant réussit et l'échec disparaît.
    await appleRemindersState(h.container).reload();
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO });
    expect(await h.pass()).toMatchObject({ status: 'done' });
    expect(status().failure).toBeNull();
  });

  it('liste présente avec shown: false : la règle de la liste décochée s’applique (corbeille des tâches non modifiées)', async () => {
    await importMany(3);
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: false });
    expect(await h.pass()).toMatchObject({ status: 'done', deleted: 3 });
  });

  it('garde de suppression massive sur ce chemin : plus de max(10, 25 %) de tâches liées, aucune n’est mise à la corbeille, toutes sont détachées et gardées', async () => {
    await importMany(12);
    await h.showList({ id: 'L-courses', name: 'Courses', spaceId: PERSO, shown: false });
    const report = await h.pass();
    expect(report).toMatchObject({ status: 'done', deleted: 0, detached: 12 });
    const tasks = await h.tasks();
    expect(tasks).toHaveLength(0);
    const rows = await h.db.driver.select<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL AND source = 'local' AND external_id IS NULL");
    expect(rows[0]?.n).toBeGreaterThanOrEqual(12);
    expect(await h.container.data.repos.appleLinks.listAll()).toEqual([]);
    expect(status().notices.some((notice) => notice.kind === 'detached')).toBe(true);
  });
});

describe('aucune impasse : liste absente du réglage ET supprimée dans Rappels (revue)', () => {
  it('les tâches sont détachées et gardées avec un message ; le passage réussit et ne s’interrompt plus', async () => {
    await importMany(3);
    await h.container.data.repos.settings.set('appleReminders.lists', { lists: [] } as never);
    await appleRemindersState(h.container).reload();
    h.reminders.removeList('L-courses');
    const report = await h.pass();
    expect(report).toMatchObject({ status: 'done', detached: 3, deleted: 0 });
    expect(status().notices.some((notice) => notice.kind === 'detached')).toBe(true);
    expect(status().failure).toBeNull();
    const rows = await h.db.driver.select<{ n: number }>("SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL AND source = 'local' AND external_id IS NULL AND title LIKE 'Rappel %'");
    expect(rows[0]?.n).toBe(3);
    expect(await h.pass()).toMatchObject({ status: 'done' });
  });

  it('réparation : « Détacher les tâches de ces listes » détache les tâches dont la liste n’est pas dans le réglage et efface l’échec', async () => {
    await importMany(3);
    await h.container.data.repos.settings.set('appleReminders.lists', { lists: [] } as never);
    await appleRemindersState(h.container).reload();
    expect(await h.pass()).toMatchObject({ status: 'failed', code: 'lists-setting-invalid' });
    expect(await detachUnlisted(h.container)).toBe(3);
    expect(status().failure).toBeNull();
    expect(await h.container.data.repos.appleLinks.listAll()).toEqual([]);
  });

  it('réparation : « Réinitialiser le réglage des listes » réécrit un réglage lisible', async () => {
    await importMany(2);
    await h.container.data.repos.settings.set('appleReminders.lists', 'illisible' as never);
    expect(await h.pass()).toMatchObject({ code: 'lists-setting-invalid' });
    await resetLists(h.container);
    expect(await h.container.data.repos.settings.get('appleReminders.lists')).toEqual({ lists: [] });
    expect(status().failure).toBeNull();
  });
});
