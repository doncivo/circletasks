import { describe, expect, it } from 'vitest';
import { affectsReminders, conflictTarget, decideRestore, parentTableOf, wantsDeleted } from './conflictRestore';
import { syncColumn, syncTable, type SyncColumn, type SyncTable } from './syncTables';

/** Règles pures de la restauration d'un conflit (Y-04 critères 2, 7 à 10 ; revue : règles dans src/domain). */

const col = (table: string, column: string): SyncColumn => syncColumn(table, column) as SyncColumn;
const tbl = (name: string): SyncTable => syncTable(name) as SyncTable;

describe('conflictTarget', () => {
  it('table et colonne visibles du catalogue seulement', () => {
    expect(conflictTarget({ table: 'task', field: 'time' })?.column.name).toBe('time');
    expect(conflictTarget({ table: 'task', field: 'sort_order' })).toBeNull();
    expect(conflictTarget({ table: 'task', field: 'discarded' })).toBeNull();
    expect(conflictTarget({ table: 'tâche', field: 'time' })).toBeNull();
    expect(conflictTarget({ table: '__proto__', field: 'constructor' })).toBeNull();
  });
});

describe('parentTableOf, wantsDeleted, affectsReminders', () => {
  it('parent d’une clé étrangère du catalogue', () => {
    expect(parentTableOf(tbl('task'), col('task', 'project_id'))?.name).toBe('project');
    expect(parentTableOf(tbl('task'), col('task', 'title'))).toBeUndefined();
  });

  it('suppression voulue : date ISO → supprimé ; nul ou « modifié » → présent ; autre → invalide', () => {
    const deletedAt = col('task', 'deleted_at');
    expect(wantsDeleted(deletedAt, '2026-10-05T08:00:00.000Z')).toBe(true);
    expect(wantsDeleted(deletedAt, null)).toBe(false);
    expect(wantsDeleted(deletedAt, 'modified')).toBe(false);
    expect(wantsDeleted(deletedAt, 'hier')).toBeNull();
  });

  it('échéance des rappels : date et heure d’une tâche, planification d’une routine, dates d’un événement', () => {
    expect(affectsReminders(tbl('task'), col('task', 'time'))).toBe(true);
    expect(affectsReminders(tbl('task'), col('task', 'date'))).toBe(true);
    expect(affectsReminders(tbl('task'), col('task', 'title'))).toBe(false);
    expect(affectsReminders(tbl('routine'), col('routine', 'time'))).toBe(true);
    expect(affectsReminders(tbl('event'), col('event', 'start_date'))).toBe(true);
    expect(affectsReminders(tbl('goal'), col('goal', 'week_start'))).toBe(false);
  });
});

describe('decideRestore', () => {
  const time = col('task', 'time');
  const project = col('task', 'project_id');
  const deletedAt = col('task', 'deleted_at');

  it('ligne purgée ou absente : refus « n’existe plus », quelle que soit la valeur', () => {
    expect(decideRestore({ column: time, discarded: '10:00', row: 'purged', current: null, parent: null })).toEqual({ kind: 'refused', reason: 'row-gone' });
    expect(decideRestore({ column: deletedAt, discarded: 'modified', row: 'missing', current: null, parent: null })).toEqual({ kind: 'refused', reason: 'row-gone' });
  });

  it('valeur invalide pour la colonne : refus', () => {
    expect(decideRestore({ column: time, discarded: '25:99', row: 'live', current: '09:00', parent: null })).toEqual({ kind: 'refused', reason: 'invalid' });
    expect(decideRestore({ column: deletedAt, discarded: 'hier', row: 'deleted', current: '2026-10-05T08:00:00.000Z', parent: null })).toEqual({ kind: 'refused', reason: 'invalid' });
  });

  it('parent non vivant (corbeille, absent, purgé) : refus « élément lié » ; vivant : écriture', () => {
    for (const parent of ['deleted', 'missing', 'purged'] as const) {
      expect(decideRestore({ column: project, discarded: '40000000-0000-4000-8000-000000000001', row: 'live', current: null, parent })).toEqual({ kind: 'refused', reason: 'parent-gone' });
    }
    expect(decideRestore({ column: project, discarded: '40000000-0000-4000-8000-000000000001', row: 'live', current: null, parent: 'live' })).toEqual({ kind: 'write' });
  });

  it('valeur déjà en place : rien ; sinon écriture, ligne à la corbeille comprise', () => {
    expect(decideRestore({ column: time, discarded: '10:00', row: 'live', current: '10:00', parent: null })).toEqual({ kind: 'already' });
    expect(decideRestore({ column: time, discarded: '10:00', row: 'deleted', current: '09:00', parent: null })).toEqual({ kind: 'write' });
  });

  it('conflit de suppression : restaurer ou supprimer l’élément, ou rien s’il est déjà dans l’état voulu', () => {
    expect(decideRestore({ column: deletedAt, discarded: 'modified', row: 'deleted', current: '2026-10-05T08:00:00.000Z', parent: null })).toEqual({ kind: 'element', deleted: false });
    expect(decideRestore({ column: deletedAt, discarded: '2026-10-05T07:00:00.000Z', row: 'live', current: null, parent: null })).toEqual({ kind: 'element', deleted: true });
    expect(decideRestore({ column: deletedAt, discarded: 'modified', row: 'live', current: null, parent: null })).toEqual({ kind: 'already' });
    expect(decideRestore({ column: deletedAt, discarded: '2026-10-05T07:00:00.000Z', row: 'deleted', current: '2026-10-05T09:00:00.000Z', parent: null })).toEqual({ kind: 'already' });
  });
});
