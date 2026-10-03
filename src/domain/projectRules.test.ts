import { describe, expect, it } from 'vitest';
import { itemFilterOf, matchesItemFilter } from './itemFilter';
import {
  PROJECT_NAME_MAX_LENGTH,
  activeProjectsOf,
  defaultProjectColor,
  effectiveProjectFilter,
  isProjectColorAllowed,
  isProjectFilterAvailable,
  moveProject,
  moveProjectTo,
  nextProjectOrder,
  projectChoicesFor,
  projectForSpace,
  validateProjectName,
} from './projectRules';
import { asEntityId, type HexColor, type ProjectId, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000002');
const pid = (n: number) => asEntityId<ProjectId>(`10000000-0000-4000-8000-00000000000${n}`);
const project = (n: number, spaceId: SpaceId, extra: Partial<{ archived: boolean; sortOrder: number }> = {}) => ({
  id: pid(n),
  spaceId,
  archived: false,
  sortOrder: n,
  deletedAt: null,
  ...extra,
});

describe('validateProjectName (ES-04 critère 2)', () => {
  it('1 à 50 caractères après nettoyage', () => {
    expect(validateProjectName('  Mission client ', [])).toEqual({ ok: true, value: 'Mission client' });
    expect(validateProjectName('x'.repeat(PROJECT_NAME_MAX_LENGTH), [])).toMatchObject({ ok: true });
    expect(validateProjectName('x'.repeat(PROJECT_NAME_MAX_LENGTH + 1), [])).toEqual({ ok: false, error: 'name-too-long' });
    expect(validateProjectName('   ', [])).toEqual({ ok: false, error: 'empty-name' });
  });
  it('unique dans l’espace sans tenir compte de la casse ; le même nom reste possible dans l’autre espace', () => {
    expect(validateProjectName('MISSION CLIENT', ['Mission client'])).toEqual({ ok: false, error: 'name-taken' });
    expect(validateProjectName('Mission client', ['Autre'])).toMatchObject({ ok: true });
  });
});

describe('palette et couleur par défaut (ES-04 critère 3)', () => {
  it('une couleur doit appartenir à la palette fixe ; le défaut est celle de l’espace', () => {
    expect(isProjectColorAllowed('#5b43a8')).toBe(true);
    expect(isProjectColorAllowed('#123456')).toBe(false);
    expect(defaultProjectColor({ color: '#2f6b7a' as HexColor })).toBe('#2f6b7a');
  });
});

describe('projets proposés (ES-04 critères 4, 5, 8)', () => {
  const all = [project(1, PRO, { sortOrder: 2 }), project(2, PRO, { sortOrder: 1 }), project(3, PRO, { archived: true }), project(4, PERSO)];
  it('seuls les projets actifs de l’espace, dans l’ordre choisi', () => {
    expect(activeProjectsOf(all, PRO).map((p) => p.id)).toEqual([pid(2), pid(1)]);
    expect(activeProjectsOf(all, PERSO).map((p) => p.id)).toEqual([pid(4)]);
    expect(activeProjectsOf([{ ...project(5, PRO), deletedAt: '2026-01-01T00:00:00.000Z' }], PRO)).toEqual([]);
  });
  it('un projet archivé n’est plus proposé mais reste affiché pour la tâche qui le porte', () => {
    expect(projectChoicesFor(all, PRO).map((p) => p.id)).toEqual([pid(2), pid(1)]);
    expect(projectChoicesFor(all, PRO, pid(3)).map((p) => p.id)).toEqual([pid(2), pid(1), pid(3)]);
    expect(projectChoicesFor(all, PERSO, pid(3)).map((p) => p.id)).toEqual([pid(4)]);
  });
  it('un projet n’est valable que dans son espace', () => {
    expect(projectForSpace(all, PRO, pid(1))).toBe(pid(1));
    expect(projectForSpace(all, PERSO, pid(1))).toBeNull();
    expect(projectForSpace(all, PRO, null)).toBeNull();
    expect(projectForSpace(all, PRO, pid(9))).toBeNull();
  });
  it('ordre : renumérotation à 1, 2, 3 ; déplacement hors liste sans effet', () => {
    const ordered = [{ id: pid(1) }, { id: pid(2) }, { id: pid(3) }];
    expect(moveProject(ordered, pid(3), -1)).toEqual([{ id: pid(1), sortOrder: 1 }, { id: pid(3), sortOrder: 2 }, { id: pid(2), sortOrder: 3 }]);
    expect(moveProject(ordered, pid(1), -1)).toEqual([]);
    expect(moveProject(ordered, pid(3), 1)).toEqual([]);
    expect(moveProject(ordered, pid(9), 1)).toEqual([]);
    expect(moveProjectTo(ordered, pid(1), 2).map((e) => e.id)).toEqual([pid(2), pid(3), pid(1)]);
    expect(moveProjectTo(ordered, pid(1), 0)).toEqual([]);
    expect(moveProjectTo(ordered, pid(1), 5)).toEqual([]);
    expect(moveProjectTo(ordered, pid(9), 1)).toEqual([]);
    expect(nextProjectOrder(all, PRO)).toBe(4); // après le dernier, archivés compris
    expect(nextProjectOrder([], PRO)).toBe(1);
  });
});

describe('filtre par projet (QB-15, ES-04 critère 6)', () => {
  const all = [project(1, PRO), project(2, PRO, { archived: true }), project(4, PERSO)];
  const noProjectSpace = [project(1, PRO)];
  it('visible sous Pro / Perso quand l’espace a un projet actif ; masqué en « Tout » et sans projet', () => {
    expect(isProjectFilterAvailable(PRO, all)).toBe(true);
    expect(isProjectFilterAvailable('all', all)).toBe(false);
    expect(isProjectFilterAvailable(PERSO, noProjectSpace)).toBe(false);
    expect(isProjectFilterAvailable(PRO, [project(2, PRO, { archived: true })])).toBe(false);
  });
  it('le projet choisi ne s’applique que dans son espace, s’il est actif', () => {
    expect(effectiveProjectFilter(PRO, pid(1), all)).toBe(pid(1));
    expect(effectiveProjectFilter(PERSO, pid(1), all)).toBeNull(); // changer d'espace remet « Tous »
    expect(effectiveProjectFilter('all', pid(1), all)).toBeNull();
    expect(effectiveProjectFilter(PRO, pid(2), all)).toBeNull(); // archivé
    expect(effectiveProjectFilter(PRO, null, all)).toBeNull();
  });
});

describe('matchesItemFilter (ES-08 critère 1)', () => {
  const task = { spaceId: PRO, projectId: pid(1) };
  it('espace puis projet ; un élément sans projet n’est compté que dans « Tous les projets »', () => {
    expect(matchesItemFilter(task, { space: 'all', project: null })).toBe(true);
    expect(matchesItemFilter(task, { space: PRO, project: pid(1) })).toBe(true);
    expect(matchesItemFilter(task, { space: PRO, project: pid(2) })).toBe(false);
    expect(matchesItemFilter(task, { space: PERSO, project: null })).toBe(false);
    expect(matchesItemFilter({ spaceId: PRO, projectId: null }, { space: PRO, project: pid(1) })).toBe(false);
    expect(matchesItemFilter({ spaceId: PRO }, { space: PRO, project: pid(1) })).toBe(false);
    expect(matchesItemFilter({ spaceId: PRO }, { space: PRO, project: null })).toBe(true);
  });
  it('itemFilterOf retire le projet hors de son espace', () => {
    const projects = [project(1, PRO)];
    expect(itemFilterOf(PRO, pid(1), projects)).toEqual({ space: PRO, project: pid(1) });
    expect(itemFilterOf(PERSO, pid(1), projects)).toEqual({ space: PERSO, project: null });
    expect(itemFilterOf('all', pid(1), projects)).toEqual({ space: 'all', project: null });
  });
});
