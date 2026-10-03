import { describe, expect, it } from 'vitest';
import { countDoneTasks, filterFocusSessions, filterRoutineLogs, focusMinutes } from './filteredAggregates';
import { focusPlacementAtLaunch, focusSeconds, projectOfFocusSession, type FocusSessionRecord } from './focusSession';
import { ALL_ITEMS, type ItemFilter } from './itemFilter';
import { asEntityId, type IsoDateTime, type ProjectId, type RoutineId, type SpaceId, type TaskId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000002');
const MISSION = asEntityId<ProjectId>('10000000-0000-4000-8000-000000000001');
const SITE = asEntityId<ProjectId>('10000000-0000-4000-8000-000000000002');
const tid = (n: number) => asEntityId<TaskId>(`20000000-0000-4000-8000-00000000000${n}`);
const rid = (n: number) => asEntityId<RoutineId>(`30000000-0000-4000-8000-00000000000${n}`);
const spaces = [
  { id: PRO, sortOrder: 1 },
  { id: PERSO, sortOrder: 2 },
];

const task = (n: number, spaceId: SpaceId, projectId: ProjectId | null, status: 'todo' | 'done' = 'done', deletedAt: IsoDateTime | null = null) => ({ id: tid(n), spaceId, projectId, status, deletedAt });
// Jeu factice : Pro / Mission client (2 faites, 1 à faire), Pro / Refonte site (1 faite), Pro sans projet (1 faite), Perso (1 faite), 1 supprimée.
const tasks = [
  task(1, PRO, MISSION),
  task(2, PRO, MISSION),
  task(3, PRO, MISSION, 'todo'),
  task(4, PRO, SITE),
  task(5, PRO, null),
  task(6, PERSO, null),
  task(7, PRO, MISSION, 'done', '2026-10-01T00:00:00.000Z' as IsoDateTime),
];
const byId = new Map(tasks.map((t) => [t.id, t]));

const at = (minute: number): IsoDateTime => new Date(Date.UTC(2026, 9, 2, 8, minute)).toISOString() as IsoDateTime;
const session = (n: number, spaceId: SpaceId, taskId: TaskId | null, from: number, to: number | null, pausedSec = 0): FocusSessionRecord => ({
  id: `40000000-0000-4000-8000-00000000000${n}` as never,
  taskId,
  spaceId,
  plannedMin: 25,
  startedAt: at(from),
  endedAt: to === null ? null : at(to),
  pausedSec,
});
// 25 min (Mission), 30 min (Mission, 5 min de pause = 25), 20 min sans tâche (Pro), 15 min (Perso), 1 en cours.
const sessions = [session(1, PRO, tid(1), 0, 25), session(2, PRO, tid(2), 30, 60, 300), session(3, PRO, null, 70, 90), session(4, PERSO, tid(6), 100, 115), session(5, PRO, tid(1), 120, null)];

const f = (space: ItemFilter['space'], project: ItemFilter['project'] = null): ItemFilter => ({ space, project });

describe('ItemFilter appliqué aux agrégats (ES-08 critères 1, 3, 4)', () => {
  it('tâches faites : « Pro · Mission client » ne compte que les éléments correspondants', () => {
    expect(countDoneTasks(tasks, f(PRO, MISSION))).toBe(2); // la tâche à faire et la supprimée sont exclues
    expect(countDoneTasks(tasks, f(PRO, SITE))).toBe(1);
    expect(countDoneTasks(tasks, f(PRO))).toBe(4);
    expect(countDoneTasks(tasks, f(PERSO))).toBe(1);
    expect(countDoneTasks(tasks, ALL_ITEMS)).toBe(5);
  });

  it('minutes de Focus : espace de la session, projet de sa tâche ; une session sans projet n’est comptée que dans « tous les projets »', () => {
    expect(focusMinutes(sessions, byId, f(PRO, MISSION))).toBe(50); // 25 + (30 - 5)
    expect(focusMinutes(sessions, byId, f(PRO, SITE))).toBe(0);
    expect(focusMinutes(sessions, byId, f(PRO))).toBe(70); // + 20 sans tâche
    expect(focusMinutes(sessions, byId, f(PERSO))).toBe(15);
    expect(focusMinutes(sessions, byId, ALL_ITEMS)).toBe(85);
    // Sans tâche : jamais dans un filtre projet.
    expect(filterFocusSessions(sessions, byId, f(PRO, MISSION)).map((s) => s.taskId)).toEqual([tid(1), tid(2), tid(1)]);
  });

  it('validations de routine : elles suivent l’espace de leur routine et jamais un filtre projet', () => {
    const routines = [
      { id: rid(1), spaceId: PRO },
      { id: rid(2), spaceId: PERSO },
    ];
    const logs = [{ routineId: rid(1) }, { routineId: rid(1) }, { routineId: rid(2) }, { routineId: rid(9) }];
    expect(filterRoutineLogs(logs, routines, f(PRO))).toHaveLength(2);
    expect(filterRoutineLogs(logs, routines, f(PERSO))).toHaveLength(1);
    expect(filterRoutineLogs(logs, routines, ALL_ITEMS)).toHaveLength(3); // la routine inconnue (9) est ignorée
    expect(filterRoutineLogs(logs, routines, f(PRO, MISSION))).toHaveLength(0);
  });
});

describe('espace d’une session Focus (ES-08 critère 2)', () => {
  it('avec une tâche : l’espace et le projet de la tâche', () => {
    expect(focusPlacementAtLaunch({ spaceId: PERSO, projectId: null }, PRO, spaces)).toEqual({ spaceId: PERSO, projectId: null });
    expect(focusPlacementAtLaunch({ spaceId: PRO, projectId: MISSION }, 'all', spaces)).toEqual({ spaceId: PRO, projectId: MISSION });
  });
  it('sans tâche : l’espace actif au lancement (filtre), Pro sous « Tout », sans projet', () => {
    expect(focusPlacementAtLaunch(null, PERSO, spaces)).toEqual({ spaceId: PERSO, projectId: null });
    expect(focusPlacementAtLaunch(null, 'all', spaces)).toEqual({ spaceId: PRO, projectId: null });
    expect(focusPlacementAtLaunch(null, 'all', [])).toBeNull();
  });
  it('le projet d’une session est celui de sa tâche ; aucun sans tâche ou tâche inconnue', () => {
    expect(projectOfFocusSession({ taskId: tid(1) }, byId)).toBe(MISSION);
    expect(projectOfFocusSession({ taskId: null }, byId)).toBeNull();
    expect(projectOfFocusSession({ taskId: tid(8) }, byId)).toBeNull();
  });
  it('temps de concentration : durée moins pauses, 0 tant que la session est en cours ou si les instants sont illisibles', () => {
    expect(focusSeconds(session(1, PRO, null, 0, 25))).toBe(1500);
    expect(focusSeconds(session(2, PRO, null, 0, 10, 600))).toBe(0);
    expect(focusSeconds(session(3, PRO, null, 0, 10, 900))).toBe(0); // jamais négatif
    expect(focusSeconds(session(4, PRO, null, 0, null))).toBe(0);
    expect(focusSeconds({ startedAt: 'illisible' as IsoDateTime, endedAt: at(5), pausedSec: 0 })).toBe(0);
  });
});
