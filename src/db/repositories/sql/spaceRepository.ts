import type { NewProject, NewSpace, Project, ProjectPatch, Space, SpacePatch } from '../../../domain/model';
import type { ProjectId, SpaceFilter, SpaceId } from '../../../domain/types';
import type { WriteStamper } from '../../../domain/hlc';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { ProjectRepository, SpaceRepository } from '../spaceRepository';
import type { ReadOptions, SortOrderEntry } from '../common';
import { deletedClause, fromJson, readSyncMeta, requireMapped, toJson, type SyncRow } from './sqlHelpers';

interface SpaceRow extends SqlRow, SyncRow {
  readonly name: string;
  readonly color: string;
  readonly sort_order: number;
  readonly quiet_hours: string;
}

function rowToSpace(row: SpaceRow): Space {
  return {
    id: row.id as SpaceId,
    name: row.name,
    color: row.color as Space['color'],
    sortOrder: row.sort_order,
    quietHours: fromJson(row.quiet_hours, []),
    ...readSyncMeta(row),
  };
}

interface ProjectRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly name: string;
  readonly color: string;
  readonly archived: number;
  readonly sort_order: number;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id as ProjectId,
    spaceId: row.space_id as SpaceId,
    name: row.name,
    color: row.color as Project['color'],
    archived: row.archived === 1,
    sortOrder: row.sort_order,
    ...readSyncMeta(row),
  };
}

export function createSpaceRepository(db: SqlExecutor, stamper: WriteStamper): SpaceRepository {
  async function fetchById(id: SpaceId, options?: ReadOptions): Promise<SpaceRow | undefined> {
    const rows = await db.select<SpaceRow>(
      `SELECT * FROM space WHERE id = ? ${deletedClause(options)} LIMIT 1`,
      [id],
    );
    return rows[0];
  }

  return {
    async listAll() {
      const rows = await db.select<SpaceRow>('SELECT * FROM space WHERE deleted_at IS NULL ORDER BY sort_order, id');
      return rows.map(rowToSpace);
    },

    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToSpace(row) : null;
    },

    async count() {
      const rows = await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM space WHERE deleted_at IS NULL');
      return rows[0]?.n ?? 0;
    },

    async create(space: NewSpace) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO space (id, name, color, sort_order, quiet_hours, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [space.id, space.name, space.color, space.sortOrder, toJson(space.quietHours), stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
      );
      return requireMapped(await fetchById(space.id), 'space', space.id, rowToSpace);
    },

    async update(id: SpaceId, patch: SpacePatch) {
      const stamp = stamper.next();
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.color !== undefined) {
        sets.push('color = ?');
        params.push(patch.color);
      }
      if (patch.sortOrder !== undefined) {
        sets.push('sort_order = ?');
        params.push(patch.sortOrder);
      }
      if (patch.quietHours !== undefined) {
        sets.push('quiet_hours = ?');
        params.push(toJson(patch.quietHours));
      }
      sets.push('updated_at = ?', 'device_id = ?', 'hlc = ?');
      params.push(stamp.at, stamp.deviceId, stamp.hlc);
      await db.execute(
        `UPDATE space SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
        [...params, id],
      );
      return requireMapped(await fetchById(id), 'space', id, rowToSpace);
    },

    async setSortOrders(entries: readonly SortOrderEntry<SpaceId>[]) {
      for (const entry of entries) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE space SET sort_order = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
          [entry.sortOrder, stamp.at, stamp.deviceId, stamp.hlc, entry.id],
        );
      }
    },
  };
}

export function createProjectRepository(db: SqlExecutor, stamper: WriteStamper): ProjectRepository {
  async function fetchById(id: ProjectId, options?: ReadOptions): Promise<ProjectRow | undefined> {
    const rows = await db.select<ProjectRow>(
      `SELECT * FROM project WHERE id = ? ${deletedClause(options)} LIMIT 1`,
      [id],
    );
    return rows[0];
  }

  return {
    async listForFilter(filter: SpaceFilter, options) {
      const params: (string | number | null)[] = [];
      let sql = 'SELECT * FROM project WHERE deleted_at IS NULL';
      if (filter !== 'all') {
        sql += ' AND space_id = ?';
        params.push(filter);
      }
      if (!options?.includeArchived) sql += ' AND archived = 0';
      sql += ' ORDER BY sort_order, id';
      const rows = await db.select<ProjectRow>(sql, params);
      return rows.map(rowToProject);
    },

    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToProject(row) : null;
    },

    async create(project: NewProject) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO project (id, space_id, name, color, archived, sort_order, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          project.id,
          project.spaceId,
          project.name,
          project.color,
          project.archived ? 1 : 0,
          project.sortOrder,
          stamp.at,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
        ],
      );
      return requireMapped(await fetchById(project.id), 'project', project.id, rowToProject);
    },

    async update(id: ProjectId, patch: ProjectPatch) {
      const stamp = stamper.next();
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.spaceId !== undefined) {
        sets.push('space_id = ?');
        params.push(patch.spaceId);
      }
      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.color !== undefined) {
        sets.push('color = ?');
        params.push(patch.color);
      }
      if (patch.archived !== undefined) {
        sets.push('archived = ?');
        params.push(patch.archived ? 1 : 0);
      }
      if (patch.sortOrder !== undefined) {
        sets.push('sort_order = ?');
        params.push(patch.sortOrder);
      }
      sets.push('updated_at = ?', 'device_id = ?', 'hlc = ?');
      params.push(stamp.at, stamp.deviceId, stamp.hlc);
      await db.execute(`UPDATE project SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
      return requireMapped(await fetchById(id), 'project', id, rowToProject);
    },

    async setArchived(id: ProjectId, archived: boolean) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE project SET archived = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [archived ? 1 : 0, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'project', id, rowToProject);
    },

    async setSortOrders(entries: readonly SortOrderEntry<ProjectId>[]) {
      for (const entry of entries) {
        const stamp = stamper.next();
        await db.execute(
          'UPDATE project SET sort_order = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
          [entry.sortOrder, stamp.at, stamp.deviceId, stamp.hlc, entry.id],
        );
      }
    },

    async softDelete(id: ProjectId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE project SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'project', id, rowToProject);
    },

    async restore(id: ProjectId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE project SET deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NOT NULL',
        [stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'project', id, rowToProject);
    },
  };
}
