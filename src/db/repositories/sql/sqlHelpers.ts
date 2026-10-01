import type { WriteStamp } from '../../../domain/hlc';
import type {
  DeviceId,
  Hlc,
  Id,
  IsoDateTime,
  SpaceFilter,
} from '../../../domain/types';
import type { SqlParams, SqlValue } from '../../driver';
import { RepositoryError, type ReadOptions } from '../common';

/** Colonnes de synchro communes à toute ligne métier (ADR 0005). */
export interface SyncRow {
  readonly id: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly device_id: string;
  readonly hlc: string;
}

/** Équivalent camelCase, lu depuis une `SyncRow`. */
export function readSyncMeta(row: SyncRow): {
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt: IsoDateTime | null;
  readonly deviceId: DeviceId;
  readonly hlc: Hlc;
} {
  return {
    createdAt: row.created_at as IsoDateTime,
    updatedAt: row.updated_at as IsoDateTime,
    deletedAt: row.deleted_at === null ? null : (row.deleted_at as IsoDateTime),
    deviceId: row.device_id as DeviceId,
    hlc: row.hlc as Hlc,
  };
}

export const toBool = (value: SqlValue): boolean => value === 1;
export const fromBool = (value: boolean): SqlValue => (value ? 1 : 0);

export const toJson = <T>(value: T): string => JSON.stringify(value);

export function fromJson<T>(value: SqlValue, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(String(value)) as T;
}

export function fromJsonOrNull<T>(value: SqlValue): T | null {
  if (value === null) return null;
  return JSON.parse(String(value)) as T;
}

/** `WHERE` additionnel pour exclure les lignes supprimées, sauf `includeDeleted`. */
export function deletedClause(options?: ReadOptions): string {
  return options?.includeDeleted ? '' : 'AND deleted_at IS NULL';
}

/** Clause de filtre d'espace (`SpaceFilter`) sur la colonne `space_id` (règle commune n°2). */
export function spaceFilterClause(filter: SpaceFilter, column = 'space_id'): { readonly sql: string; readonly params: SqlParams } {
  if (filter === 'all') return { sql: '', params: [] };
  return { sql: `AND ${column} = ?`, params: [filter] };
}

/** Lève `RepositoryError('not-found', …)` si la ligne est absente (règle commune n°5). */
export function requireRow<T>(row: T | undefined, entity: string, id: string): T {
  if (row === undefined) throw new RepositoryError('not-found', entity, id);
  return row;
}

/** `requireRow` suivi de la conversion ligne → entité (règle commune n°4). */
export function requireMapped<R, E>(row: R | undefined, entity: string, id: string, map: (row: R) => E): E {
  return map(requireRow(row, entity, id));
}

/** Place `id` en dernier paramètre, pour `WHERE id = ?` en fin de requête UPDATE. */
export function stampParams(stamp: WriteStamp): SqlParams {
  return [stamp.at, stamp.deviceId, stamp.hlc];
}

/** Identifiants `IN (?, ?, …)` : fragment SQL et paramètres associés. */
export function inClause(ids: readonly Id[]): { readonly sql: string; readonly params: SqlParams } {
  if (ids.length === 0) return { sql: '(NULL)', params: [] };
  return { sql: `(${ids.map(() => '?').join(', ')})`, params: ids };
}
