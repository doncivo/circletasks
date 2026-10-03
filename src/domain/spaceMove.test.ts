import { describe, expect, it } from 'vitest';
import { changesPlacement, moveDestinations, moveToSpace, resolveMoveTarget } from './spaceMove';
import { asEntityId, type ProjectId, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000002');
const MISSION = asEntityId<ProjectId>('10000000-0000-4000-8000-000000000001');
const MAISON = asEntityId<ProjectId>('10000000-0000-4000-8000-000000000002');
const projects = [
  { id: MISSION, spaceId: PRO, archived: false, sortOrder: 1 },
  { id: MAISON, spaceId: PERSO, archived: false, sortOrder: 1 },
  { id: asEntityId<ProjectId>('10000000-0000-4000-8000-000000000003'), spaceId: PRO, archived: true, sortOrder: 2 },
];

describe('déplacement vers un espace ou un projet (ES-05)', () => {
  it('Pro / Mission client → Perso : le projet est remis à « aucun » (critère 1)', () => {
    const task = { spaceId: PRO, projectId: MISSION, date: '2026-10-02', title: 'Facture' };
    expect(moveToSpace(task, PERSO, null, projects)).toEqual({ ...task, spaceId: PERSO, projectId: null });
    // Un projet d'un autre espace demandé avec l'espace : ignoré.
    expect(moveToSpace(task, PERSO, MISSION, projects)).toMatchObject({ spaceId: PERSO, projectId: null });
  });

  it('un autre projet du même espace : seul le projet change (critère 2)', () => {
    const task = { spaceId: PERSO, projectId: null };
    expect(moveToSpace(task, PERSO, MAISON, projects)).toEqual({ spaceId: PERSO, projectId: MAISON });
    expect(resolveMoveTarget(PRO, MISSION, projects)).toEqual({ spaceId: PRO, projectId: MISSION });
    expect(resolveMoveTarget(PRO, asEntityId<ProjectId>('10000000-0000-4000-8000-0000000000ff'), projects)).toEqual({ spaceId: PRO, projectId: null });
  });

  it('conserve tout le reste : date, heure, rappels, objectif, statut (critère 7)', () => {
    const task = { spaceId: PRO, projectId: MISSION, date: '2026-10-02', time: '09:00', status: 'todo', goalId: 'g', reminders: [0] };
    expect(moveToSpace(task, PERSO, null, projects)).toEqual({ ...task, spaceId: PERSO, projectId: null });
  });

  it('un déplacement sans effet est détecté', () => {
    expect(changesPlacement({ spaceId: PRO, projectId: MISSION }, { spaceId: PRO, projectId: MISSION })).toBe(false);
    expect(changesPlacement({ spaceId: PRO, projectId: null }, { spaceId: PRO, projectId: null })).toBe(false);
    expect(changesPlacement({ spaceId: PRO }, { spaceId: PRO, projectId: null })).toBe(false);
    expect(changesPlacement({ spaceId: PRO, projectId: MISSION }, { spaceId: PRO, projectId: null })).toBe(true);
    expect(changesPlacement({ spaceId: PRO, projectId: null }, { spaceId: PERSO, projectId: null })).toBe(true);
  });

  it('destinations de « Déplacer » (Q12) : par espace, « aucun projet » puis les projets actifs', () => {
    const spaces = [
      { id: PERSO, sortOrder: 2 },
      { id: PRO, sortOrder: 1 },
    ];
    expect(moveDestinations(spaces, projects)).toEqual([
      { spaceId: PRO, projectId: null },
      { spaceId: PRO, projectId: MISSION },
      { spaceId: PERSO, projectId: null },
      { spaceId: PERSO, projectId: MAISON },
    ]);
  });
});
