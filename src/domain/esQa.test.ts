import { describe, expect, it } from 'vitest';
import { PROJECT_NAME_MAX_LENGTH, validateProjectName } from './projectRules';
import { moveDestinations, moveToSpace } from './spaceMove';
import { SPACE_NAME_MAX_LENGTH, validateSpaceName } from './spaceRules';

const PRO = 'pro' as never;
const PERSO = 'perso' as never;
const MISSION = 'p-mission' as never;
const projects = [
  { id: MISSION, spaceId: PRO, archived: false, sortOrder: 1 },
  { id: 'p-old' as never, spaceId: PRO, archived: true, sortOrder: 2 },
];

describe('ES QA : cas limites', () => {
  it('ES-01 critère 4 : bornes 30/31 caractères, espaces internes conservés, doublon insensible à la casse après trim', () => {
    expect(validateSpaceName(' ' + 'a'.repeat(SPACE_NAME_MAX_LENGTH) + ' ', [])).toMatchObject({ ok: true });
    expect(validateSpaceName('a'.repeat(SPACE_NAME_MAX_LENGTH + 1), [])).toMatchObject({ ok: false });
    expect(validateSpaceName('  PERSO ', ['Perso'])).toEqual({ ok: false, error: 'name-taken' });
  });
  it('ES-04 critère 2 : bornes 50/51 caractères et doublon de casse différente', () => {
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH), [])).toMatchObject({ ok: true });
    expect(validateProjectName('a'.repeat(PROJECT_NAME_MAX_LENGTH + 1), [])).toMatchObject({ ok: false });
    expect(validateProjectName('MISSION client', ['Mission client'])).toEqual({ ok: false, error: 'name-taken' });
  });
  it('ES-05 critère 1 : un projet d’un autre espace est remis à aucun, y compris par lot', () => {
    const items = [{ spaceId: PRO, projectId: MISSION }, { spaceId: PRO, projectId: null }];
    for (const item of items) expect(moveToSpace(item, PERSO, MISSION, projects)).toEqual({ spaceId: PERSO, projectId: null });
  });
  it('ES-04 critère 5 / ES-05 : un projet archivé n’est jamais proposé comme destination', () => {
    const ids = moveDestinations([{ id: PRO, sortOrder: 1 }, { id: PERSO, sortOrder: 2 }], projects).map((d) => d.projectId);
    expect(ids).toEqual([null, MISSION, null]);
  });
});
