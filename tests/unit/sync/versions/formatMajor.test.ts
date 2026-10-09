import { describe, expect, it } from 'vitest';
import { SYNC_FORMAT_MAJOR } from '../../../../src/domain/sync/format';
import { SYNC_TABLES, type SyncTable } from '../../../../src/domain/sync/syncTables';

/**
 * Garde de la version majeure (Y-07 critère 8 ; ADR 0011 §7.2, decisions.md « Ce qu'est la version majeure ») : une colonne publiée ne
 * peut être retirée, renommée ni changer de type sans augmenter `SYNC_FORMAT_MAJOR` (l'autre appareil, resté à l'ancienne version, ne
 * saurait plus la lire). Ajouter une colonne ou une table reste permis (migration additive : `sv` seulement).
 *
 * Copie figée des colonnes publiées au format majeur 1. Quand `SYNC_FORMAT_MAJOR` augmente, la copie est refaite pour la nouvelle majeure.
 */

const PUBLISHED_AT_MAJOR_1: Readonly<Record<string, readonly string[]>> = {
  space: ['name:text', 'color:text', 'sort_order:real', 'quiet_hours:json', 'created_at:datetime', 'deleted_at:datetime'],
  project: ['space_id:id', 'name:text', 'color:text', 'archived:bool', 'sort_order:real', 'created_at:datetime', 'deleted_at:datetime'],
  recurrence: ['freq:enum', 'interval:int', 'weekdays:json', 'month_day:int', 'nth_weekday:text', 'until:text', 'count:int', 'created_at:datetime', 'deleted_at:datetime'],
  goal: ['space_id:id', 'week_start:date', 'title:text', 'icon:text', 'pinned:bool', 'status:enum', 'carried_from_id:id', 'created_at:datetime', 'deleted_at:datetime'],
  task: ['space_id:id', 'project_id:id', 'title:text', 'note:text', 'date:date', 'time:time', 'status:enum', 'done_at:datetime', 'sort_order:real', 'carried_over:bool', 'recurrence_id:id', 'series_index:int', 'goal_id:id', 'icon:text', 'someday:bool', 'source:enum', 'external_id:text', 'series_template:json', 'external_event_id:text', 'apple_list_id:text', 'apple_recurring:bool', 'created_at:datetime', 'deleted_at:datetime'],
  routine: ['space_id:id', 'title:text', 'icon:text', 'schedule_type:enum', 'weekdays:json', 'times_per_week:int', 'interval:int', 'start_date:date', 'time:time', 'archived:bool', 'created_at:datetime', 'deleted_at:datetime'],
  routine_log: ['routine_id:id', 'date:date', 'done_at:datetime', 'created_at:datetime', 'deleted_at:datetime'],
  routine_pause: ['routine_id:id', 'from_date:date', 'to_date:date', 'created_at:datetime', 'deleted_at:datetime'],
  reminder: ['target_type:enum', 'target_id:id', 'offset_min:int', 'fire_at:localdatetime', 'delivered:bool', 'created_at:datetime', 'deleted_at:datetime'],
  event: ['space_id:id', 'title:text', 'start_date:date', 'start_time:time', 'end_date:date', 'end_time:time', 'all_day:bool', 'kind:enum', 'repeat:enum', 'important:bool', 'icon:text', 'birth_year:int', 'created_at:datetime', 'deleted_at:datetime'],
  checklist: ['space_id:id', 'title:text', 'date:date', 'is_template:bool', 'icon:text', 'created_at:datetime', 'deleted_at:datetime'],
  checklist_item: ['checklist_id:id', 'text:text', 'checked:bool', 'sort_order:real', 'created_at:datetime', 'deleted_at:datetime'],
  focus_session: ['task_id:id', 'space_id:id', 'planned_min:int', 'started_at:datetime', 'ended_at:datetime', 'paused_sec:int', 'paused_at:datetime', 'project_id:id', 'created_at:datetime', 'deleted_at:datetime'],
  calendar_account: ['provider:enum', 'label:text', 'calendars:json', 'created_at:datetime', 'deleted_at:datetime'],
  holiday: ['country:enum', 'year:int', 'key:text', 'date:date', 'name:text', 'kind:enum', 'source:enum', 'overridden:bool', 'created_at:datetime', 'deleted_at:datetime'],
  settings: ['value:json'],
};

/** Colonnes de la copie figée absentes du catalogue, ou de type changé (`table.colonne:type`). */
function removedOrChanged(frozen: Readonly<Record<string, readonly string[]>>, tables: readonly SyncTable[]): string[] {
  const current = new Map(tables.map((t) => [t.name as string, new Set(t.columns.map((c) => `${c.name}:${c.type}`))]));
  return Object.entries(frozen).flatMap(([table, columns]) => columns.filter((col) => !current.get(table)?.has(col)).map((col) => `${table}.${col}`));
}

describe('version majeure du format (Y-07 critère 8)', () => {
  it('au format majeur 1, aucune colonne publiée retirée, renommée ni retypée', () => {
    expect(SYNC_FORMAT_MAJOR, 'nouvelle majeure : refaire la copie figée de ce test').toBe(1);
    expect(removedOrChanged(PUBLISHED_AT_MAJOR_1, SYNC_TABLES)).toEqual([]);
  });

  it('le contrôle échoue bien sur une colonne retirée, renommée ou retypée, pas sur un ajout', () => {
    const task = SYNC_TABLES.find((t) => t.name === 'task') as SyncTable;
    const others = SYNC_TABLES.filter((t) => t !== task);
    const withTask = (columns: SyncTable['columns']) => [...others, { ...task, columns }];
    expect(removedOrChanged(PUBLISHED_AT_MAJOR_1, withTask(task.columns.filter((c) => c.name !== 'note')))).toEqual(['task.note:text']);
    expect(removedOrChanged(PUBLISHED_AT_MAJOR_1, withTask(task.columns.map((c) => (c.name === 'note' ? { ...c, name: 'body' } : c))))).toEqual(['task.note:text']);
    expect(removedOrChanged(PUBLISHED_AT_MAJOR_1, withTask(task.columns.map((c) => (c.name === 'note' ? { ...c, type: 'json' as const } : c))))).toEqual(['task.note:text']);
    expect(removedOrChanged(PUBLISHED_AT_MAJOR_1, others)).toHaveLength(PUBLISHED_AT_MAJOR_1['task']?.length ?? -1);
    expect(removedOrChanged(PUBLISHED_AT_MAJOR_1, withTask([...task.columns, { name: 'x', type: 'text', nullable: true, conflictVisible: true }]))).toEqual([]);
  });
});
