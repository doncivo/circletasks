import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newEntityId, uuidGenerator } from '../../../domain/id';
import { encodeIcon, type EventFields, type NewEvent } from '../../../domain/model';
import { asEntityId, asLocalDate as d, asLocalTime as tm, type DeviceId, type EventId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { RepositoryError } from '../common';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000008');

const fields = (over: Partial<EventFields> = {}): EventFields => ({
  spaceId: SPACE_PRO_ID,
  title: 'Point client',
  startDate: d('2026-09-23'),
  startTime: tm('10:00'),
  endDate: d('2026-09-23'),
  endTime: tm('11:00'),
  allDay: false,
  kind: 'event',
  repeat: 'once',
  important: false,
  icon: null,
  birthYear: null,
  ...over,
});

const newEvent = (over: Partial<EventFields> = {}): NewEvent => ({ id: newEntityId<EventId>(uuidGenerator), ...fields(over) });

describe('EventRepository (SQL) — écritures de E-01', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(async () => {
    await db.close();
  });

  it('crée un événement relu tel quel, avec ses colonnes de synchro', async () => {
    const created = await db.data.repos.events.create(newEvent({ icon: { kind: 'lucide', name: 'gift' }, important: true, repeat: 'yearly', kind: 'birthday', allDay: true, startTime: null, endTime: null, birthYear: 1992 }));
    expect(created).toMatchObject({ title: 'Point client', allDay: true, kind: 'birthday', repeat: 'yearly', important: true, birthYear: 1992, deletedAt: null, deviceId: DEVICE });
    expect(created.icon).toEqual({ kind: 'lucide', name: 'gift' });
    expect(created.hlc).toBeTruthy();
    expect(await db.data.repos.events.getById(created.id as EventId)).toEqual(created);
    expect(encodeIcon(created.icon as NonNullable<typeof created.icon>)).toBe('lucide:gift');
  });

  it('une modification change toute la série et le hlc ; seuls les champs donnés bougent', async () => {
    const created = await db.data.repos.events.create(newEvent({ repeat: 'monthly' }));
    db.clock.advance(5);
    const updated = await db.data.repos.events.update(created.id as EventId, { title: 'Comité', spaceId: SPACE_PERSO_ID, startTime: tm('14:00'), endTime: tm('15:00'), important: true });
    expect(updated).toMatchObject({ title: 'Comité', spaceId: SPACE_PERSO_ID, startTime: '14:00', endTime: '15:00', important: true, repeat: 'monthly', startDate: '2026-09-23' });
    expect(updated.hlc > created.hlc).toBe(true);
    expect(updated.createdAt).toBe(created.createdAt);
    const cleared = await db.data.repos.events.update(created.id as EventId, { icon: null, allDay: true, startTime: null, endTime: null });
    expect(cleared).toMatchObject({ allDay: true, startTime: null, icon: null });
  });

  it('suppression logique puis restauration ; absent des lectures tant que supprimé', async () => {
    const created = await db.data.repos.events.create(newEvent());
    const range = { from: d('2026-01-01'), to: d('2026-12-31') };
    expect(await db.data.repos.events.listCandidatesForRange(range, 'all')).toHaveLength(1);
    const deleted = await db.data.repos.events.softDelete(created.id as EventId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await db.data.repos.events.listCandidatesForRange(range, 'all')).toHaveLength(0);
    expect(await db.data.repos.events.getById(created.id as EventId)).toBeNull();
    expect((await db.data.repos.events.getById(created.id as EventId, { includeDeleted: true }))?.deletedAt).not.toBeNull();
    const restored = await db.data.repos.events.restore(created.id as EventId);
    expect(restored.deletedAt).toBeNull();
    expect(restored.hlc > deleted.hlc).toBe(true);
    expect(await db.data.repos.events.listCandidatesForRange(range, 'all')).toHaveLength(1);
  });

  it('filtre d’espace sur la lecture ; événement absent : not-found', async () => {
    await db.data.repos.events.create(newEvent({ spaceId: SPACE_PRO_ID }));
    await db.data.repos.events.create(newEvent({ spaceId: SPACE_PERSO_ID, title: 'Perso' }));
    const range = { from: d('2026-09-01'), to: d('2026-09-30') };
    expect((await db.data.repos.events.listCandidatesForRange(range, SPACE_PERSO_ID)).map((e) => e.title)).toEqual(['Perso']);
    expect(await db.data.repos.events.listCandidatesForRange(range, 'all')).toHaveLength(2);
    const missing = asEntityId<EventId>('92000000-0000-4000-8000-00000000ffff');
    await expect(db.data.repos.events.update(missing, { title: 'x' })).rejects.toBeInstanceOf(RepositoryError);
    await expect(db.data.repos.events.softDelete(missing)).rejects.toBeInstanceOf(RepositoryError);
  });
});
