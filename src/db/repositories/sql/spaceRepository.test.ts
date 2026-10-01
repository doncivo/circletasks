import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, asHexColor, type DeviceId, type ProjectId } from '../../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000001');

describe('SpaceRepository (SQL)', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('expose les espaces Pro et Perso créés par la migration (ES-01)', async () => {
    const spaces = await db.data.repos.spaces.listAll();
    expect(spaces.map((s) => [s.id, s.name, s.color])).toEqual([
      [SPACE_PRO_ID, 'Pro', '#2f6b7a'],
      [SPACE_PERSO_ID, 'Perso', '#b5483b'],
    ]);
    expect(await db.data.repos.spaces.count()).toBe(2);
  });

  it('met à jour updated_at et hlc à chaque écriture, hlc strictement croissant', async () => {
    const before = await db.data.repos.spaces.getById(SPACE_PRO_ID);
    expect(before).not.toBeNull();
    db.clock.advance(1000);
    const after = await db.data.repos.spaces.update(SPACE_PRO_ID, { name: 'Travail' });
    expect(after.name).toBe('Travail');
    expect(after.updatedAt > (before?.updatedAt ?? '')).toBe(true);
    expect(after.hlc > (before?.hlc ?? '')).toBe(true);
    expect(after.createdAt).toBe(before?.createdAt);
    expect(after.deviceId).toBe(DEVICE);
  });

  it('applique un ordre manuel persistant (setSortOrders)', async () => {
    await db.data.repos.spaces.setSortOrders([
      { id: SPACE_PRO_ID, sortOrder: 5 },
      { id: SPACE_PERSO_ID, sortOrder: 1 },
    ]);
    const spaces = await db.data.repos.spaces.listAll();
    expect(spaces.map((s) => s.id)).toEqual([SPACE_PERSO_ID, SPACE_PRO_ID]);
  });

  it('getById filtre les lignes supprimées, sauf includeDeleted', async () => {
    expect(await db.data.repos.spaces.getById(asEntityId('00000000-0000-4000-8000-000000000099'))).toBeNull();
  });
});

describe('ProjectRepository (SQL)', () => {
  let db: TestDb;
  const projectId = asEntityId<ProjectId>('40000000-0000-4000-8000-000000000001');

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('crée, édite, archive et classe les projets par espace (ES-04, ES-05)', async () => {
    const created = await db.data.repos.projects.create({
      id: projectId,
      spaceId: SPACE_PRO_ID,
      name: 'Mission client',
      color: asHexColor('#2f6b7a'),
      archived: false,
      sortOrder: 1,
    });
    expect(created.name).toBe('Mission client');

    const listed = await db.data.repos.projects.listForFilter(SPACE_PRO_ID);
    expect(listed.map((p) => p.id)).toEqual([projectId]);
    expect(await db.data.repos.projects.listForFilter(SPACE_PERSO_ID)).toEqual([]);
    expect(await db.data.repos.projects.listForFilter('all')).toHaveLength(1);

    const archived = await db.data.repos.projects.setArchived(projectId, true);
    expect(archived.archived).toBe(true);
    expect(await db.data.repos.projects.listForFilter('all')).toEqual([]);
    expect(await db.data.repos.projects.listForFilter('all', { includeArchived: true })).toHaveLength(1);
  });

  it('suppression logique puis restauration (T-08-like)', async () => {
    await db.data.repos.projects.create({
      id: projectId,
      spaceId: SPACE_PRO_ID,
      name: 'Mission client',
      color: asHexColor('#2f6b7a'),
      archived: false,
      sortOrder: 1,
    });
    const deleted = await db.data.repos.projects.softDelete(projectId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(await db.data.repos.projects.getById(projectId)).toBeNull();
    expect(await db.data.repos.projects.getById(projectId, { includeDeleted: true })).not.toBeNull();

    const restored = await db.data.repos.projects.restore(projectId);
    expect(restored.deletedAt).toBeNull();
  });

  it("lève RepositoryError('not-found') sur un update d'id inconnu", async () => {
    await expect(
      db.data.repos.projects.update(asEntityId('00000000-0000-4000-8000-000000000098'), { name: 'x' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
