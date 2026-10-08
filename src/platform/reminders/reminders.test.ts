import { describe, expect, it, vi } from 'vitest';
import type { IsoDateTime, LocalDate } from '../../domain/types';
import { createFakeReminders, createUnavailableReminders, openRemindersPlatform, RemindersError, type FakeReminders } from './index';
import { createTauriReminders, failureOf, parseAccess, parseFetch, parseItem } from './tauriReminders';

const AT = '2026-10-08T08:00:00.000Z';
const item = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'R1', externalRef: 'E1', listId: 'L1', title: 'Courses', due: { date: '2026-10-09', time: '10:00' }, completed: false, completedAt: null, recurring: false, modifiedAt: AT, createdAt: AT, ...patch,
});

describe('adaptateur Tauri : réponses analysées strictement (K-05 critère 5)', () => {
  it('un élément valide est lu ; chaque écart de forme est un échec « read-failed », jamais une valeur par défaut', () => {
    expect(parseItem(item())).toEqual({ id: 'R1', externalRef: 'E1', listId: 'L1', title: 'Courses', due: { date: '2026-10-09', time: '10:00' }, completed: false, completedAt: null, recurring: false, modifiedAt: AT, createdAt: AT });
    expect(parseItem(item({ due: null, externalRef: null, modifiedAt: null })).due).toBeNull();
    expect(parseItem(item({ due: { date: '2026-10-09', time: null } })).due).toEqual({ date: '2026-10-09', time: null });
    for (const bad of [null, 'x', [], item({ id: '' }), item({ id: 3 }), item({ title: null }), item({ completed: 'oui' }), item({ recurring: 1 }), item({ due: { date: '2026-13-01', time: null } }), item({ due: { date: '2026-10-09', time: '25:00' } }), item({ due: 'demain' }), item({ completedAt: 'hier' }), item({ modifiedAt: 5 }), item({ externalRef: 4 })]) {
      expect(() => parseItem(bad), JSON.stringify(bad)).toThrowError(new RemindersError('read-failed'));
    }
  });

  it('accès et lecture groupée', () => {
    for (const access of ['not-determined', 'denied', 'restricted', 'full']) expect(parseAccess({ access })).toBe(access);
    expect(() => parseAccess({ access: 'writeOnly' })).toThrow();
    expect(() => parseAccess(null)).toThrow();
    const parsed = parseFetch({ lists: [{ listId: 'L1', total: 740, items: [item()] }], byId: [item({ id: 'R2' })], missing: ['R3'], missingLists: ['L9'] });
    expect(parsed.lists[0]?.total).toBe(740);
    expect(parsed.byId[0]?.id).toBe('R2');
    expect(parsed.missing).toEqual(['R3']);
    for (const bad of [{}, { lists: [], byId: [], missing: [1], missingLists: [] }, { lists: [{ listId: 'L1', total: -1, items: [] }], byId: [], missing: [], missingLists: [] }, { lists: [{ listId: 'L1', total: 1, items: [{}] }], byId: [], missing: [], missingLists: [] }]) {
      expect(() => parseFetch(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('un rejet du plugin est un code du contrat ; tout autre rejet devient « store-unavailable » sans son texte', () => {
    expect(failureOf('recurring-refused').code).toBe('recurring-refused');
    expect(failureOf(new Error('access-denied')).code).toBe('access-denied');
    expect(failureOf({ message: 'write-failed' }).code).toBe('write-failed');
    for (const other of ['Mon rappel « Appeler le notaire » est illisible', new Error('plugin reminders not found'), 42, null, undefined]) {
      const error = failureOf(other);
      expect(error.code).toBe('store-unavailable');
      expect(error.message).not.toContain('notaire');
    }
    const known = new RemindersError('not-found');
    expect(failureOf(known)).toBe(known);
  });

  it('les commandes portent les noms et les champs du contrat ; aucun champ de plus', async () => {
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
    const answers: Record<string, unknown> = {
      status: { access: 'full' },
      request_access: { access: 'full' },
      lists: { lists: [{ id: 'L1', name: 'Courses', writable: true }] },
      fetch: { lists: [], byId: [], missing: [], missingLists: [] },
      upsert: { item: item() },
      set_completed: { item: item({ completed: true, completedAt: AT }) },
      delete: {},
    };
    const platform = createTauriReminders((command, args) => {
      calls.push({ command, args });
      return Promise.resolve(answers[command.replace('plugin:reminders|', '')]);
    });
    expect(platform.available).toBe(true);
    await platform.status();
    await platform.requestAccess();
    expect(await platform.lists()).toEqual([{ id: 'L1', name: 'Courses', writable: true }]);
    await platform.fetch({ listIds: ['L1'], limitPerList: 500, ids: [{ id: 'R1', externalRef: null, extra: 'ignoré' } as never] });
    await platform.upsert({ id: null, listId: 'L1', title: 'T', due: { date: '2026-10-09' as LocalDate, time: null }, completed: false, completedAt: null });
    await platform.setCompleted({ id: 'R1', completed: true, completedAt: AT as IsoDateTime });
    await platform.delete({ id: 'R1' });
    expect(calls.map((call) => call.command)).toEqual(['plugin:reminders|status', 'plugin:reminders|request_access', 'plugin:reminders|lists', 'plugin:reminders|fetch', 'plugin:reminders|upsert', 'plugin:reminders|set_completed', 'plugin:reminders|delete']);
    expect(calls[3]?.args).toEqual({ listIds: ['L1'], scopeListIds: ['L1'], limitPerList: 500, ids: [{ id: 'R1', externalRef: null }] });
    expect(calls[4]?.args).toEqual({ id: null, listId: 'L1', title: 'T', due: { date: '2026-10-09', time: null }, completed: false, completedAt: null });
    expect(calls[5]?.args).toEqual({ id: 'R1', completed: true, completedAt: AT });
    expect(calls[6]?.args).toEqual({ id: 'R1' });
  });

  it('une réponse hors forme ou un rejet inconnu font échouer la commande (aucun silence)', async () => {
    const malformed = createTauriReminders(() => Promise.resolve({ lists: 'non' }));
    await expect(malformed.lists()).rejects.toMatchObject({ code: 'read-failed' });
    await expect(malformed.status()).rejects.toMatchObject({ code: 'read-failed' });
    const rejecting = createTauriReminders(() => Promise.reject(new Error('quelque chose')));
    await expect(rejecting.fetch({ listIds: [], limitPerList: 1, ids: [] })).rejects.toMatchObject({ code: 'store-unavailable' });
  });

  it('l’écoute de « changed » se désinscrit', async () => {
    const unregister = vi.fn();
    const listen = vi.fn(() => Promise.resolve(unregister));
    const platform = createTauriReminders(() => Promise.resolve({}), listen);
    const stop = await platform.onChanged(() => undefined);
    expect(listen).toHaveBeenCalledWith('changed', expect.any(Function));
    stop();
    expect(unregister).toHaveBeenCalledOnce();
    await expect(createTauriReminders(() => Promise.resolve({}), () => Promise.reject(new Error('x'))).onChanged(() => undefined)).rejects.toMatchObject({ code: 'store-unavailable' });
  });
});

describe('implémentation « indisponible » (PC et navigateur)', () => {
  it('aucun appel : tout rejette « store-unavailable », l’accès vaut « denied »', async () => {
    const platform = createUnavailableReminders();
    expect(platform.available).toBe(false);
    expect(await platform.status()).toBe('denied');
    for (const call of [() => platform.requestAccess(), () => platform.lists(), () => platform.fetch({ listIds: [], limitPerList: 1, ids: [] }), () => platform.upsert({ id: null, listId: 'L', title: 'x', due: null, completed: false, completedAt: null }), () => platform.setCompleted({ id: 'R', completed: true, completedAt: null }), () => platform.delete({ id: 'R' })]) {
      await expect(call()).rejects.toMatchObject({ code: 'store-unavailable' });
    }
    const stop = await platform.onChanged(() => undefined);
    stop();
  });

  it('le résolveur rend « indisponible » sur PC et dans le navigateur, et le faux injecté en développement seulement', () => {
    expect(openRemindersPlatform('tauri', 'windows').available).toBe(false);
    expect(openRemindersPlatform('web', 'other').available).toBe(false);
    expect(openRemindersPlatform('tauri', 'ios').available).toBe(true);
    const scope = globalThis as { __ctReminders?: unknown; __ctRemindersFake?: boolean };
    scope.__ctRemindersFake = true;
    try {
      const injected = openRemindersPlatform('web', 'other');
      expect(injected.available).toBe(true);
      expect(scope.__ctReminders).toBe(injected);
      expect(openRemindersPlatform('tauri', 'windows')).toBe(injected);
    } finally {
      delete scope.__ctReminders;
      delete scope.__ctRemindersFake;
    }
  });
});

describe('faux EventKit (même règles que le plugin Swift)', () => {
  const clock = { ms: Date.parse(AT) };
  function store(): FakeReminders {
    const fake = createFakeReminders({ now: () => clock.ms });
    fake.addList({ id: 'L1', name: 'Courses', writable: true });
    fake.addList({ id: 'L2', name: 'Lecture', writable: false });
    return fake;
  }

  it('accès : tout est refusé sans accès complet ; la demande ne change l’accès qu’une fois', async () => {
    const fake = createFakeReminders({ access: 'not-determined', onRequest: 'denied' });
    expect(await fake.status()).toBe('not-determined');
    await expect(fake.lists()).rejects.toMatchObject({ code: 'access-denied' });
    expect(await fake.requestAccess()).toBe('denied');
    const granted = createFakeReminders({ access: 'not-determined' });
    expect(await granted.requestAccess()).toBe('full');
    expect(granted.writes).toEqual([]);
  });

  it('lecture : non terminés seulement, échéance croissante puis sans échéance, plafond et total, liste absente, identifiants relus', async () => {
    const fake = store();
    fake.add({ listId: 'L1', title: 'Sans date' });
    fake.add({ listId: 'L1', title: 'Tard', due: { date: '2026-10-12' as LocalDate, time: null } });
    fake.add({ listId: 'L1', title: 'Tôt', due: { date: '2026-10-09' as LocalDate, time: '09:00' as never } });
    fake.add({ listId: 'L1', title: 'Fait', completed: true });
    const done = fake.add({ id: 'DONE', listId: 'L1', title: 'Terminé suivi', completed: true });
    const result = await fake.fetch({ listIds: ['L1', 'L404'], limitPerList: 2, ids: [{ id: done.id, externalRef: null }, { id: 'ABSENT', externalRef: null }] });
    expect(result.lists).toHaveLength(1);
    expect(result.lists[0]?.total).toBe(3);
    expect(result.lists[0]?.items.map((i) => i.title)).toEqual(['Tôt', 'Tard']);
    expect(result.missingLists).toEqual(['L404']);
    expect(result.byId.map((i) => i.id)).toEqual(['DONE']);
    expect(result.missing).toEqual(['ABSENT']);
    expect(fake.writes).toEqual([]);
  });

  it('écriture : création dans une liste écrivable, relue avec modifiedAt ; refus listes, récurrents, entrée invalide', async () => {
    const fake = store();
    const created = await fake.upsert({ id: null, listId: 'L1', title: '  Acheter du pain  ', due: { date: '2026-10-09' as LocalDate, time: null }, completed: false, completedAt: null });
    expect(created).toMatchObject({ title: 'Acheter du pain', listId: 'L1', modifiedAt: AT });
    await expect(fake.upsert({ id: null, listId: 'L2', title: 'x', due: null, completed: false, completedAt: null })).rejects.toMatchObject({ code: 'read-only-list' });
    await expect(fake.upsert({ id: null, listId: 'L9', title: 'x', due: null, completed: false, completedAt: null })).rejects.toMatchObject({ code: 'list-not-found' });
    await expect(fake.upsert({ id: null, listId: 'L1', title: '   ', due: null, completed: false, completedAt: null })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(fake.upsert({ id: 'NOPE', listId: 'L1', title: 'x', due: null, completed: false, completedAt: null })).rejects.toMatchObject({ code: 'not-found' });
    const series = fake.add({ listId: 'L1', title: 'Série', recurring: true });
    await expect(fake.upsert({ id: series.id, listId: 'L1', title: 'x', due: null, completed: false, completedAt: null })).rejects.toMatchObject({ code: 'recurring-refused' });
    await expect(fake.setCompleted({ id: series.id, completed: true, completedAt: null })).rejects.toMatchObject({ code: 'recurring-refused' });
    await expect(fake.delete({ id: series.id })).rejects.toMatchObject({ code: 'recurring-refused' });
    expect(fake.writes.map((write) => write.kind)).toEqual(['create']);
  });

  it('terminer, rouvrir, supprimer (idempotent) ; modifications faites dans Rappels avancent modifiedAt sans écriture journalisée', async () => {
    const fake = store();
    const reminder = fake.add({ listId: 'L1', title: 'Pain' });
    clock.ms += 60_000;
    const completed = await fake.setCompleted({ id: reminder.id, completed: true, completedAt: '2026-10-08T08:30:00.000Z' as IsoDateTime });
    expect(completed).toMatchObject({ completed: true, completedAt: '2026-10-08T08:30:00.000Z', modifiedAt: '2026-10-08T08:01:00.000Z' });
    expect((await fake.setCompleted({ id: reminder.id, completed: false, completedAt: null })).completedAt).toBeNull();
    await fake.delete({ id: reminder.id });
    await fake.delete({ id: reminder.id });
    expect(fake.get(reminder.id)).toBeUndefined();
    expect(fake.writes.map((write) => write.kind)).toEqual(['complete', 'complete', 'delete']);
    const other = fake.add({ listId: 'L1', title: 'Lait' });
    clock.ms += 1_000;
    fake.edit(other.id, { title: 'Lait demi-écrémé' });
    expect(fake.get(other.id)).toMatchObject({ title: 'Lait demi-écrémé', modifiedAt: '2026-10-08T08:01:01.000Z' });
    expect(fake.writes).toHaveLength(3);
  });

  it('pannes injectées, événement changed et journal des appels', async () => {
    const fake = store();
    const listener = vi.fn();
    const stop = await fake.onChanged(listener);
    expect(fake.listenerCount()).toBe(1);
    fake.emitChanged();
    expect(listener).toHaveBeenCalledOnce();
    await fake.upsert({ id: null, listId: 'L1', title: 'x', due: null, completed: false, completedAt: null });
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    expect(fake.listenerCount()).toBe(0);
    fake.failNext('lists', 'store-unavailable', 2);
    await expect(fake.lists()).rejects.toMatchObject({ code: 'store-unavailable' });
    await expect(fake.lists()).rejects.toMatchObject({ code: 'store-unavailable' });
    expect(await fake.lists()).toHaveLength(2);
    expect(fake.calls.map((call) => call.name)).toEqual(['upsert', 'lists', 'lists', 'lists']);
  });
});

describe('relecture par identifiant : rien au-delà de la liste et de l’identifiant hors des listes suivies (audit B1)', () => {
  it('l’adaptateur envoie les listes suivies (« scopeListIds ») et lit un élément minimal sans valeur par défaut trompeuse', async () => {
    const calls: Record<string, unknown>[] = [];
    const platform = createTauriReminders((_command, args) => {
      calls.push(args ?? {});
      return Promise.resolve({ lists: [], byId: [{ id: 'R9', listId: 'L-privee' }, item({ id: 'R2' })], missing: [], missingLists: [] });
    });
    const result = await platform.fetch({ listIds: [], scopeListIds: ['L1'], limitPerList: 500, ids: [{ id: 'R9', externalRef: null }, { id: 'R2', externalRef: null }] });
    expect(calls[0]).toMatchObject({ listIds: [], scopeListIds: ['L1'] });
    expect(result.byId[0]).toEqual({ id: 'R9', listId: 'L-privee', externalRef: null, title: '', due: null, completed: false, completedAt: null, recurring: false, modifiedAt: null, createdAt: null });
    expect(result.byId[1]?.title).toBe('Courses');
    // Un élément partiel autre que {id, listId} reste un échec de lecture.
    expect(() => parseFetch({ lists: [], byId: [{ id: 'R9', listId: 'L', title: 'x' }], missing: [], missingLists: [] })).toThrowError(new RemindersError('read-failed'));
  });

  it('le faux ne rend que l’identifiant et la liste d’un élément hors des listes suivies, et tout pour un élément suivi', async () => {
    const fake = createFakeReminders();
    fake.addList({ id: 'L1', name: 'Suivie', writable: true });
    fake.addList({ id: 'L2', name: 'Privée', writable: true });
    const followed = fake.add({ listId: 'L1', title: 'Visible' });
    const hidden = fake.add({ listId: 'L2', title: 'Secret' });
    const result = await fake.fetch({ listIds: [], scopeListIds: ['L1'], limitPerList: 10, ids: [{ id: followed.id, externalRef: null }, { id: hidden.id, externalRef: null }] });
    expect(result.byId.find((entry) => entry.id === followed.id)?.title).toBe('Visible');
    expect(result.byId.find((entry) => entry.id === hidden.id)).toEqual({ id: hidden.id, listId: 'L2', externalRef: null, title: '', due: null, completed: false, completedAt: null, recurring: false, modifiedAt: null, createdAt: null });
    expect(JSON.stringify(result)).not.toContain('Secret');
  });
});
