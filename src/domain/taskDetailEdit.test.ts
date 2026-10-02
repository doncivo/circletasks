import { describe, expect, it } from 'vitest';
import type { Task } from './model';
import { choiceOfTask, editSheetPatch, patchFromDateChoice } from './taskDetailEdit';
import { asEntityId, asLocalDate, asLocalTime, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const day = asLocalDate('2026-10-02');

const task = (over: Partial<Task> = {}): Task =>
  ({ title: 'Facture', icon: null, spaceId: PRO, date: day, time: asLocalTime('09:00'), someday: false, ...over }) as unknown as Task;

describe('patchFromDateChoice (A-08)', () => {
  it('« Un jour » : someday seul (les invariants effacent date et heure)', () => {
    expect(patchFromDateChoice({ date: null, time: null })).toEqual({ someday: true });
  });
  it('une date avec heure sort la tâche de « Un jour »', () => {
    expect(patchFromDateChoice({ date: asLocalDate('2026-10-05'), time: asLocalTime('10:30') })).toEqual({ someday: false, date: '2026-10-05', time: '10:30' });
    expect(patchFromDateChoice({ date: day, time: null })).toEqual({ someday: false, date: day, time: null });
  });
});

describe('editSheetPatch (A-08, Q15)', () => {
  const draft = (over: Partial<Parameters<typeof editSheetPatch>[1]> = {}) => ({ title: 'Facture', icon: null, choice: choiceOfTask(task()), spaceId: PRO, ...over });

  it('un brouillon identique ne change rien', () => {
    expect(editSheetPatch(task(), draft())).toEqual({});
  });
  it('ne rend que les champs changés', () => {
    expect(editSheetPatch(task(), draft({ title: 'Facture client' }))).toEqual({ title: 'Facture client' });
    expect(editSheetPatch(task(), draft({ icon: { kind: 'emoji', value: '💶' } as never }))).toEqual({ icon: { kind: 'emoji', value: '💶' } });
  });
  it('changer d’espace retire le projet', () => {
    expect(editSheetPatch(task(), draft({ spaceId: PERSO }))).toEqual({ spaceId: PERSO, projectId: null });
  });
  it('changer la date ou l’heure, ou passer en « Un jour »', () => {
    expect(editSheetPatch(task(), draft({ choice: { date: day, time: null } }))).toEqual({ someday: false, date: day, time: null });
    expect(editSheetPatch(task(), draft({ choice: { date: null, time: null } }))).toEqual({ someday: true });
  });
  it('une tâche « Un jour » reste inchangée si le choix reste « Un jour »', () => {
    const someday = task({ date: null, time: null, someday: true });
    expect(editSheetPatch(someday, draft({ choice: choiceOfTask(someday) }))).toEqual({});
  });
});
