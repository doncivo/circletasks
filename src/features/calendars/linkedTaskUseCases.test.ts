import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ACCOUNT } from '../../../tests/sim';
import type { InstantRange } from '../../db/repositories';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { externalEventRowId } from '../../domain/calendarProvider';
import type { CalendarAccountId, ExternalEventId } from '../../domain/types';
import { undoMessage } from '../app/undo';
import { calendarsStore } from './calendarsStore';
import { createLinkedTaskUseCases } from './linkedTaskUseCases';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;

let h: CalendarHarness;
let accountId: CalendarAccountId;
const store = () => calendarsStore.get(h.container);
const useCases = () => createLinkedTaskUseCases(h.container);
const idOf = (externalId: string, calendarId = GOOGLE_ACCOUNT): ExternalEventId => externalEventRowId(accountId, calendarId, externalId);

async function connected(): Promise<void> {
  const outcome = await store().getState().connectGoogle();
  if (!outcome.ok) throw new Error(outcome.failure);
  accountId = outcome.accountId;
  await vi.waitFor(() => expect(store().getState().states[accountId]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
  await vi.waitFor(() => expect(store().getState().refreshing).toEqual([]));
}

beforeEach(async () => {
  h = await setupCalendarHarness('51');
  await connected();
});
afterEach(() => h.close());

describe('créer une tâche depuis un événement externe (K-04)', () => {
  it('titre de l’événement, date locale de son début, sans heure, espace de l’agenda, sans projet, lien posé (critère 2)', async () => {
    const result = await useCases().createFromEvent(idOf('point-client'));
    expect(result.ok).toBe(true);
    const task = result.ok ? result.task : null;
    expect(task).toMatchObject({ title: 'Point client', date: '2026-09-23', time: null, spaceId: SPACE_PRO_ID, projectId: null, someday: false, status: 'todo', source: 'local', externalEventId: idOf('point-client') });
    expect(await h.container.data.repos.tasks.getById(task?.id as never)).toMatchObject({ externalEventId: idOf('point-client') });
    expect(h.container.taskEntities.get(task?.id as never)).toBeDefined();
  });

  it('l’espace est celui de l’agenda (ES-06) ; un agenda sans espace reçoit l’espace par défaut ; événement inconnu : introuvable', async () => {
    const calendars = store().getState().accounts[0]?.calendars ?? [];
    await store().getState().setCalendars(accountId, calendars.map((calendar) => (calendar.name === 'Famille' ? { ...calendar, spaceId: SPACE_PERSO_ID } : calendar)));
    await vi.waitFor(() => expect(store().getState().refreshing).toEqual([]));
    const family = await useCases().createFromEvent(idOf('vacances', 'famille@group.calendar.google.com'));
    expect(family.ok && family.task.spaceId).toBe(SPACE_PERSO_ID);
    // Un agenda arrivé de la synchro sans espace (écriture directe, hors validation de l'écran).
    await h.container.data.repos.calendarAccounts.updateCalendars(accountId, calendars.map((calendar) => ({ ...calendar, spaceId: null })));
    const free = await useCases().createFromEvent(idOf('point-client'));
    expect(free.ok && free.task.spaceId).toBe(SPACE_PRO_ID);
    expect(await useCases().createFromEvent(idOf('inconnu'))).toEqual({ ok: false, error: 'not-found' });
  });

  it('journée entière ou plusieurs jours : premier jour, sans décalage ; événement sans titre : « (Sans titre) » (critère 4)', async () => {
    const holiday = await useCases().createFromEvent(idOf('vacances', 'famille@group.calendar.google.com'));
    expect(holiday.ok && [holiday.task.date, holiday.task.title]).toEqual(['2026-10-19', 'Vacances']);
    const untitled = await useCases().createFromEvent(idOf('sans-titre', 'famille@group.calendar.google.com'));
    expect(untitled.ok && [untitled.task.date, untitled.task.title]).toEqual(['2026-09-25', '(Sans titre)']);
  });

  it('une tâche par événement : un événement déjà lié rend sa tâche (critère 5)', async () => {
    const first = await useCases().createFromEvent(idOf('point-client'));
    const second = await useCases().createFromEvent(idOf('point-client'));
    expect(first.ok && second).toEqual({ ok: false, error: 'already-linked', task: first.ok ? first.task : undefined });
    expect((await useCases().linkedTask(idOf('point-client')))?.id).toBe(first.ok ? first.task.id : '');
    expect((await h.container.data.repos.tasks.listForWeek('2026-09-21' as never, 'all')).filter((task) => task.title === 'Point client')).toHaveLength(1);
  });

  it('message « Tâche créée pour le 23 sept. » avec annulation ; annuler (ou Ctrl+Z) supprime la tâche et rétablit le bouton (critères 2 et 8)', async () => {
    const result = await useCases().createFromEvent(idOf('point-client'));
    const snapshot = h.container.undo.getSnapshot();
    expect(snapshot.top && undoMessage(snapshot.top)).toBe('Tâche créée pour le 23 sept.');
    expect(await h.container.undo.undoLast()).toMatchObject({ status: 'undone' });
    expect(await useCases().linkedTask(idOf('point-client'))).toBeNull();
    expect(h.container.taskEntities.get(result.ok ? result.task.id : ('' as never))).toBeUndefined();
    // Une nouvelle création est possible, et la corbeille n'a rien à restaurer.
    expect((await useCases().createFromEvent(idOf('point-client'))).ok).toBe(true);
    expect(await h.container.data.repos.tasks.listTrash('2026-01-01T00:00:00.000Z' as never, 'all')).toEqual([]);
  });

  it('annulation refusée si la tâche a changé depuis (hlc) : « stale », rien n’est supprimé', async () => {
    const result = await useCases().createFromEvent(idOf('point-client'));
    if (!result.ok) throw new Error('création');
    h.db.clock.advance(1000);
    await h.container.data.repos.tasks.update(result.task.id, { title: 'Renommée' });
    expect(await h.container.undo.undoLast()).toMatchObject({ status: 'stale' });
    expect((await useCases().linkedTask(idOf('point-client')))?.title).toBe('Renommée');
  });
});

describe('le lien survit aux rafraîchissements (K-04 D4, critères 6, 7 et 9)', () => {
  it('un rafraîchissement garde l’identifiant de la ligne, donc le lien ; un événement déplacé reste le même', async () => {
    await useCases().createFromEvent(idOf('point-client'));
    h.google.setEvents([{ calendarId: GOOGLE_ACCOUNT, id: 'point-client', status: 'confirmed', summary: 'Point client (déplacé)', start: { dateTime: '2026-09-24T10:00:00+02:00' }, end: { dateTime: '2026-09-24T11:00:00+02:00' } }]);
    h.db.clock.advance(60_000);
    await store().getState().refresh(accountId, 'manual');
    expect((await h.container.data.repos.externalEvents.getById(idOf('point-client')))?.title).toBe('Point client (déplacé)');
    expect((await useCases().linkedTask(idOf('point-client')))?.title).toBe('Point client');
  });

  it('l’événement disparaît : la tâche reste intacte (titre, date), son événement est introuvable', async () => {
    const created = await useCases().createFromEvent(idOf('point-client'));
    h.google.setEvents([]);
    h.db.clock.advance(60_000);
    await store().getState().refresh(accountId, 'manual');
    expect(await h.container.data.repos.externalEvents.getById(idOf('point-client'))).toBeNull();
    expect(await h.container.data.repos.tasks.getById(created.ok ? created.task.id : ('' as never))).toMatchObject({ title: 'Point client', date: '2026-09-23', externalEventId: idOf('point-client') });
  });

  it('compte supprimé : les tâches liées gardent titre et date', async () => {
    const created = await useCases().createFromEvent(idOf('point-client'));
    await store().getState().removeAccount(accountId);
    expect(await h.container.data.repos.externalEvents.listBetween(wide)).toEqual([]);
    expect(await h.container.data.repos.tasks.getById(created.ok ? created.task.id : ('' as never))).toMatchObject({ title: 'Point client', date: '2026-09-23' });
  });

  it('modifier, déplacer ou terminer la tâche ne change pas l’événement ; supprimer la tâche non plus (critère 7)', async () => {
    const created = await useCases().createFromEvent(idOf('point-client'));
    if (!created.ok) throw new Error('création');
    const before = await h.container.data.repos.externalEvents.getById(idOf('point-client'));
    h.db.clock.advance(1000);
    await h.container.data.repos.tasks.update(created.task.id, { date: '2026-10-05' as never, title: 'Autre' });
    await h.container.data.repos.tasks.complete(created.task.id, '2026-09-23T10:00:00.000Z' as never);
    await h.container.data.repos.tasks.softDelete([created.task.id]);
    expect(await h.container.data.repos.externalEvents.getById(idOf('point-client'))).toEqual(before);
  });
});
