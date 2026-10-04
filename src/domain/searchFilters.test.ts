import { describe, expect, it } from 'vitest';
import {
  NO_SEARCH_FILTERS,
  hasActiveSearchFilters,
  initialSearchFilters,
  periodRange,
  searchedKinds,
  storedStatuses,
  toQueryFilters,
  withSpace,
} from './searchFilters';
import { asLocalDate, type ProjectId, type SpaceId } from './types';

const d = asLocalDate;
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const PERSO = '00000000-0000-4000-8000-000000000002' as SpaceId;

describe('bornes de période (RC-02 critère 5)', () => {
  const friday = d('2026-10-02');

  it('Cette semaine : du lundi au dimanche', () => {
    expect(periodRange({ kind: 'week' }, friday)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(periodRange({ kind: 'week' }, d('2026-10-04'))).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(periodRange({ kind: 'week' }, d('2026-10-05'))).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  });

  it('Ce mois : du 1er au dernier jour, février bissextile compris', () => {
    expect(periodRange({ kind: 'month' }, friday)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodRange({ kind: 'month' }, d('2028-02-10'))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodRange({ kind: 'month' }, d('2026-02-10'))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('30 derniers jours : aujourd’hui et les 29 jours précédents', () => {
    expect(periodRange({ kind: 'last30' }, friday)).toEqual({ from: '2026-09-03', to: '2026-10-02' });
  });

  it('dates choisies : remises dans l’ordre si la fin précède le début', () => {
    expect(periodRange({ kind: 'custom', from: d('2026-09-10'), to: d('2026-09-20') }, friday)).toEqual({ from: '2026-09-10', to: '2026-09-20' });
    expect(periodRange({ kind: 'custom', from: d('2026-09-20'), to: d('2026-09-10') }, friday)).toEqual({ from: '2026-09-10', to: '2026-09-20' });
  });
});

describe('statut et types cherchés (critères 3 et 4)', () => {
  it('« À faire » : tâches todo et objectifs ouverts ; « Fait » : tâches faites et objectifs atteints', () => {
    expect(storedStatuses('todo')).toEqual({ task: 'todo', goal: 'open' });
    expect(storedStatuses('done')).toEqual({ task: 'done', goal: 'achieved' });
  });

  it('sans filtre, les cinq types ; un type choisi ne garde que lui', () => {
    expect(searchedKinds(NO_SEARCH_FILTERS)).toEqual(['task', 'checklist', 'event', 'routine', 'goal']);
    expect(searchedKinds({ ...NO_SEARCH_FILTERS, kind: 'checklist' })).toEqual(['checklist']);
  });

  it('un statut masque tous les types sauf tâches et objectifs', () => {
    expect(searchedKinds({ ...NO_SEARCH_FILTERS, status: 'done' })).toEqual(['task', 'goal']);
    expect(searchedKinds({ ...NO_SEARCH_FILTERS, status: 'done', kind: 'checklist' })).toEqual([]);
  });

  it('une période exclut routines (sans date) ; un projet ne garde que les tâches', () => {
    expect(searchedKinds({ ...NO_SEARCH_FILTERS, period: { kind: 'week' } })).toEqual(['task', 'checklist', 'event', 'goal']);
    expect(searchedKinds({ ...NO_SEARCH_FILTERS, space: PRO, projectId: 'p1' as ProjectId })).toEqual(['task']);
  });
});

describe('filtres combinés (critères 6 et 7)', () => {
  it('un espace repris à l’ouverture, le reste vide ; « Réinitialiser » revient à Tout', () => {
    expect(initialSearchFilters(PRO)).toEqual({ space: PRO, projectId: null, kind: null, status: null, period: null });
    expect(hasActiveSearchFilters(NO_SEARCH_FILTERS)).toBe(false);
    expect(hasActiveSearchFilters(initialSearchFilters(PRO))).toBe(true);
    expect(hasActiveSearchFilters({ ...NO_SEARCH_FILTERS, status: 'todo' })).toBe(true);
  });

  it('changer d’espace remet « Projet : tous »', () => {
    const withProject = { ...initialSearchFilters(PRO), projectId: 'p1' as ProjectId };
    expect(withSpace(withProject, PERSO).projectId).toBeNull();
    expect(withSpace(withProject, PRO)).toBe(withProject);
  });

  it('traduit les filtres en paramètres de requête (objectif : semaine qui touche la période)', () => {
    const query = toQueryFilters({ ...initialSearchFilters(PRO), status: 'done', period: { kind: 'week' } }, d('2026-10-02'));
    expect(query).toEqual({
      space: PRO,
      projectId: null,
      kinds: ['task', 'goal'],
      statuses: { task: 'done', goal: 'achieved' },
      period: { from: '2026-09-28', to: '2026-10-04' },
      goalPeriod: { from: '2026-09-22', to: '2026-10-04' },
    });
    expect(toQueryFilters(NO_SEARCH_FILTERS, d('2026-10-02'))).toMatchObject({ statuses: null, period: null, goalPeriod: null });
  });
});
