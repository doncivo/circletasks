import { describe, expect, it } from 'vitest';
import type { RecurrenceFields, Task } from './model';
import {
  changedSeriesFields,
  decodeSeriesTemplate,
  DELETE_SCOPES,
  divergedTemplate,
  RULE_EDIT_SCOPES,
  ruleChanged,
  scopeChoicesForEdit,
  seriesAnchorDate,
  seriesSourceOf,
  seriesValuesPatch,
} from './recurrenceEdit';
import { asEntityId, asId, asLocalDate, asLocalTime, asSpaceId, type RecurrenceId, type TaskId } from './types';

const d = asLocalDate;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const occurrence: Task = {
  id: asEntityId<TaskId>(uuid(2)),
  createdAt: '2026-09-01T10:00:00.000Z' as Task['createdAt'],
  updatedAt: '2026-09-23T10:00:00.000Z' as Task['updatedAt'],
  deletedAt: null,
  deviceId: asId(uuid(9)) as Task['deviceId'],
  hlc: 'x' as Task['hlc'],
  spaceId: asSpaceId(uuid(3)),
  projectId: null,
  title: 'Payer le loyer',
  note: '',
  date: d('2026-09-23'),
  time: asLocalTime('09:00'),
  status: 'todo',
  doneAt: null,
  sortOrder: 1,
  carriedOver: false,
  recurrenceId: asEntityId<RecurrenceId>(uuid(1)),
  seriesIndex: 2,
  seriesTemplate: null,
  goalId: null,
  icon: { kind: 'emoji', value: '🏠' },
  someday: false,
  source: 'local',
  externalId: null,
};

const rule: RecurrenceFields = { freq: 'monthly', interval: 1, weekdays: [], monthDay: 23, nthWeekday: null, until: null, count: null };

describe('changedSeriesFields (T-10 critère 1)', () => {
  it('liste les champs dont la valeur change réellement', () => {
    expect(changedSeriesFields(occurrence, { title: 'Loyer', note: 'virement', time: asLocalTime('10:00'), date: d('2026-09-25') })).toEqual([
      'title',
      'note',
      'time',
      'date',
    ]);
  });

  it('ignore une valeur identique, dont l’icône comparée par contenu', () => {
    expect(changedSeriesFields(occurrence, { title: 'Payer le loyer', icon: { kind: 'emoji', value: '🏠' }, date: d('2026-09-23') })).toEqual([]);
    expect(changedSeriesFields(occurrence, { icon: { kind: 'lucide', name: 'house' } })).toEqual(['icon']);
    expect(changedSeriesFields(occurrence, { icon: null })).toEqual(['icon']);
  });

  it('espace et projet sont des valeurs de la série', () => {
    expect(changedSeriesFields(occurrence, { spaceId: asSpaceId(uuid(4)), projectId: null })).toEqual(['spaceId']);
  });
});

describe('scopeChoicesForEdit (critères 1 et 4)', () => {
  it('une occurrence modifiée propose les deux choix', () => {
    expect(scopeChoicesForEdit(occurrence, { note: 'x' })).toEqual(['occurrence', 'following']);
  });

  it('un changement de date seul propose les deux choix', () => {
    expect(scopeChoicesForEdit(occurrence, { date: d('2026-09-30') })).toEqual(['occurrence', 'following']);
  });

  it('aucune question sans changement réel ni sur une tâche simple', () => {
    expect(scopeChoicesForEdit(occurrence, { note: '' })).toEqual([]);
    expect(scopeChoicesForEdit({ ...occurrence, recurrenceId: null }, { note: 'x' })).toEqual([]);
  });

  it('la règle n’admet que « Toutes les suivantes » ; la suppression les deux', () => {
    expect(RULE_EDIT_SCOPES).toEqual(['following']);
    expect(DELETE_SCOPES).toEqual(['occurrence', 'following']);
  });
});

describe('valeurs de la série et occurrence détachée (critère 2)', () => {
  it('divergedTemplate garde les valeurs d’avant, date prévue comprise', () => {
    expect(divergedTemplate(occurrence)).toEqual({
      title: 'Payer le loyer',
      note: '',
      icon: { kind: 'emoji', value: '🏠' },
      time: '09:00',
      spaceId: occurrence.spaceId,
      projectId: null,
      date: '2026-09-23',
    });
  });

  it('une occurrence déjà détachée garde ses valeurs d’origine', () => {
    const template = divergedTemplate(occurrence);
    const detached: Task = { ...occurrence, title: 'Loyer (exception)', seriesTemplate: template };
    expect(divergedTemplate(detached)).toBe(template);
  });

  it('seriesSourceOf rend les valeurs de la série, l’occurrence elle-même sinon', () => {
    expect(seriesSourceOf(occurrence)).toBe(occurrence);
    const detached: Task = { ...occurrence, title: 'Exception', note: 'seule', seriesTemplate: divergedTemplate(occurrence) };
    expect(seriesSourceOf(detached)).toMatchObject({ title: 'Payer le loyer', note: '', time: '09:00', date: '2026-09-23' });
  });

  it('seriesAnchorDate : la date d’origine si l’occurrence a été déplacée', () => {
    expect(seriesAnchorDate(occurrence)).toBe('2026-09-23');
    expect(seriesAnchorDate({ date: d('2026-09-30'), seriesTemplate: divergedTemplate(occurrence) })).toBe('2026-09-23');
  });

  it('seriesValuesPatch retire la date et les champs hors série', () => {
    expect(seriesValuesPatch({ title: 'A', date: d('2026-09-30'), goalId: null })).toEqual({ title: 'A' });
  });
});

describe('ruleChanged', () => {
  it('détecte fréquence, jours, fin', () => {
    expect(ruleChanged(rule, { ...rule })).toBe(false);
    expect(ruleChanged(rule, { ...rule, until: d('2026-12-31') })).toBe(true);
    expect(ruleChanged(rule, { ...rule, count: 6 })).toBe(true);
    expect(ruleChanged(rule, { ...rule, interval: 2 })).toBe(true);
    expect(ruleChanged({ ...rule, freq: 'weekly', monthDay: null, weekdays: [1] }, { ...rule, freq: 'weekly', monthDay: null, weekdays: [1, 3] })).toBe(true);
    expect(ruleChanged({ ...rule, monthDay: null, nthWeekday: { nth: 2, weekday: 1 } }, { ...rule, monthDay: null, nthWeekday: { nth: 2, weekday: 3 } })).toBe(true);
  });
});

describe('decodeSeriesTemplate (données issues d’une autre version ou de la synchro)', () => {
  const valid = {
    title: 'Loyer',
    note: '',
    icon: 'emoji:🏠',
    time: '09:00',
    spaceId: uuid(3),
    projectId: null,
    date: '2026-09-23',
  };
  const decode = (value: unknown) => decodeSeriesTemplate(JSON.stringify(value));

  it('accepte un gabarit valide et décode l’icône', () => {
    expect(decode(valid)).toEqual({ ok: true, value: { ...valid, icon: { kind: 'emoji', value: '🏠' } } });
    expect(decode({ ...valid, icon: null, time: null, date: null })).toMatchObject({ ok: true });
  });

  it('refuse un JSON illisible ou qui n’est pas un objet', () => {
    expect(decodeSeriesTemplate('{oups')).toEqual({ ok: false, error: 'invalid_json' });
    expect(decode(null)).toEqual({ ok: false, error: 'invalid_shape' });
    expect(decode([valid])).toEqual({ ok: false, error: 'invalid_shape' });
    expect(decode('texte')).toEqual({ ok: false, error: 'invalid_shape' });
  });

  it.each([
    ['titre vide', { title: '  ' }],
    ['titre non texte', { title: 3 }],
    ['espace absent', { spaceId: undefined }],
    ['espace invalide', { spaceId: 'x' }],
    ['projet invalide', { projectId: 12 }],
    ['heure invalide', { time: '25:99' }],
    ['date invalide', { date: '2026-13-40' }],
    ['icône inconnue', { icon: 'lucide:inconnue' }],
    ['note non texte', { note: null }],
  ])('refuse un champ invalide : %s', (_name, change) => {
    expect(decode({ ...valid, ...change })).toEqual({ ok: false, error: 'invalid_field' });
  });
});
