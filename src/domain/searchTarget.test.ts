import { describe, expect, it } from 'vitest';
import { resultTarget } from './searchTarget';
import { asLocalDate } from './types';

const hit = (kind: 'task' | 'checklist' | 'event' | 'routine' | 'goal', extra: { date?: string | null; someday?: boolean } = {}) => ({
  kind,
  id: `${kind}-1`,
  date: extra.date === undefined ? null : extra.date === null ? null : asLocalDate(extra.date),
  someday: extra.someday ?? false,
});

describe('cible d’un résultat (RC-03)', () => {
  it('une tâche s’ouvre en fiche détail par-dessus l’onglet courant, « Un jour » et terminée comprises (critères 2 et 4)', () => {
    expect(resultTarget(hit('task', { date: '2026-09-23' }))).toEqual({ tab: null, screen: null, date: null, checklistId: null, detail: { type: 'task', id: 'task-1' } });
    expect(resultTarget(hit('task', { someday: true })).tab).toBeNull();
    expect(resultTarget(hit('task', { someday: true })).detail).toEqual({ type: 'task', id: 'task-1' });
  });

  it('Ctrl+Entrée : la tâche s’ouvre dans son onglet, au jour de sa date ou dans « Un jour » (critère 6)', () => {
    expect(resultTarget(hit('task', { date: '2026-09-23' }), { inTab: true })).toMatchObject({ tab: 'tasks', screen: 'today', date: '2026-09-23', detail: { type: 'task' } });
    expect(resultTarget(hit('task', { someday: true }), { inTab: true })).toMatchObject({ tab: 'tasks', screen: 'someday', date: null });
    expect(resultTarget(hit('task'), { inTab: true })).toMatchObject({ tab: 'tasks', screen: 'today', date: null });
  });

  it('une checklist ouvre l’onglet Checklists sur elle ; un événement, sa feuille ; une routine, sa fiche ; un objectif, l’écran Objectif (critère 3)', () => {
    expect(resultTarget(hit('checklist'))).toMatchObject({ tab: 'checklists', checklistId: 'checklist-1', detail: null });
    expect(resultTarget(hit('event'))).toMatchObject({ tab: 'events', detail: { type: 'event', id: 'event-1' } });
    expect(resultTarget(hit('routine'))).toMatchObject({ tab: 'routines', detail: { type: 'routine', id: 'routine-1' } });
    expect(resultTarget(hit('goal'))).toMatchObject({ tab: 'tasks', screen: 'goals', detail: null });
  });

  it('Ctrl+Entrée ne change rien pour les types autres que la tâche', () => {
    for (const kind of ['checklist', 'event', 'routine', 'goal'] as const) {
      expect(resultTarget(hit(kind), { inTab: true })).toEqual(resultTarget(hit(kind)));
    }
  });
});
