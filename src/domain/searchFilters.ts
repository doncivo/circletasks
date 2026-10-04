import { addDays, daysInMonth, makeLocalDate, parseLocalDate } from './localDate';
import { SEARCH_KINDS, type SearchKind } from './search';
import type { LocalDate, ProjectId, SpaceFilter } from './types';
import { weekStartOf } from './week';

/**
 * Filtres de la recherche (RC-02) : espace, projet, type, statut, période. Règles pures ; les filtres sont appliqués dans la requête
 * (`SearchRepository.query`), jamais après coup. Ils ne sont pas mémorisés (critère 7) et se combinent par « et » (critère 6).
 */

/** Statut cherché : « À faire » ou « Fait » (tâches) ; pour un objectif : ouvert ou atteint. */
export type SearchStatusFilter = 'todo' | 'done';

/** Période : choix rapides ou deux dates choisies (sélecteurs T-14). */
export type SearchPeriod =
  | { readonly kind: 'week' }
  | { readonly kind: 'month' }
  | { readonly kind: 'last30' }
  | { readonly kind: 'custom'; readonly from: LocalDate; readonly to: LocalDate };

export const SEARCH_PERIOD_KINDS = ['week', 'month', 'last30', 'custom'] as const satisfies readonly SearchPeriod['kind'][];

export interface SearchFilters {
  readonly space: SpaceFilter;
  /** Projet (tâches seulement) : n'a de sens que pour un espace unique. */
  readonly projectId: ProjectId | null;
  /** null : tous les types. */
  readonly kind: SearchKind | null;
  /** null : tous les statuts. */
  readonly status: SearchStatusFilter | null;
  /** null : toutes les dates, éléments sans date compris. */
  readonly period: SearchPeriod | null;
}

/** Aucun filtre : « Tout », « Tous », « Tous ». */
export const NO_SEARCH_FILTERS: SearchFilters = { space: 'all', projectId: null, kind: null, status: null, period: null };

/** Filtres d'une recherche neuve : l'espace du filtre global (ES-03) est repris, le reste est vide (critère 7). */
export function initialSearchFilters(space: SpaceFilter): SearchFilters {
  return { ...NO_SEARCH_FILTERS, space };
}

/** Au moins un filtre est actif (bouton « Réinitialiser », puces mises en évidence). */
export function hasActiveSearchFilters(filters: SearchFilters): boolean {
  return filters.space !== 'all' || filters.projectId !== null || filters.kind !== null || filters.status !== null || filters.period !== null;
}

/** Changer d'espace remet « Projet : tous » (le projet appartient à un espace). */
export function withSpace(filters: SearchFilters, space: SpaceFilter): SearchFilters {
  return filters.space === space ? filters : { ...filters, space, projectId: null };
}

export interface SearchDateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/**
 * Bornes (incluses) d'une période : « Cette semaine » du lundi au dimanche, « Ce mois » du 1er au dernier jour, « 30 derniers jours »
 * d'il y a 29 jours à aujourd'hui, dates choisies (les deux dates sont remises dans l'ordre si besoin).
 */
export function periodRange(period: SearchPeriod, today: LocalDate): SearchDateRange {
  switch (period.kind) {
    case 'week': {
      const from = weekStartOf(today);
      return { from, to: addDays(from, 6) };
    }
    case 'month': {
      const { year, month } = parseLocalDate(today);
      return { from: makeLocalDate(year, month, 1), to: makeLocalDate(year, month, daysInMonth(year, month)) };
    }
    case 'last30':
      return { from: addDays(today, -29), to: today };
    case 'custom':
      return period.from <= period.to ? { from: period.from, to: period.to } : { from: period.to, to: period.from };
  }
}

/** Statuts stockés correspondants : tâche `todo` / `done`, objectif `open` / `achieved`. */
export function storedStatuses(status: SearchStatusFilter): { readonly task: 'todo' | 'done'; readonly goal: 'open' | 'achieved' } {
  return status === 'todo' ? { task: 'todo', goal: 'open' } : { task: 'done', goal: 'achieved' };
}

/** Types qui portent un statut (critère 4) : tâches et objectifs ; les autres sont masqués sous un statut. */
const STATUS_KINDS: readonly SearchKind[] = ['task', 'goal'];
/** Types qui ont une date (critère 5) : les routines et les éléments sans date sont exclus sous une période. */
const DATED_KINDS: readonly SearchKind[] = ['task', 'checklist', 'event', 'goal'];

/** Types réellement cherchés une fois tous les filtres combinés (un filtre de projet ne garde que les tâches, ES-04). */
export function searchedKinds(filters: SearchFilters): readonly SearchKind[] {
  return SEARCH_KINDS.filter(
    (kind) =>
      (filters.kind === null || filters.kind === kind) &&
      (filters.status === null || STATUS_KINDS.includes(kind)) &&
      (filters.period === null || DATED_KINDS.includes(kind)) &&
      (filters.projectId === null || kind === 'task'),
  );
}

/** Paramètres de `SearchRepository.query` déduits des filtres (hors expression de recherche et limite). */
export interface SearchQueryFilters {
  readonly space: SpaceFilter;
  readonly projectId: ProjectId | null;
  readonly kinds: readonly SearchKind[];
  readonly statuses: { readonly task: 'todo' | 'done'; readonly goal: 'open' | 'achieved' } | null;
  /** Dates (incluses) d'une tâche, d'un événement ou d'une checklist. */
  readonly period: SearchDateRange | null;
  /** Un objectif tombe dans la période si sa semaine la touche : son lundi est au plus 6 jours avant le début. */
  readonly goalPeriod: SearchDateRange | null;
}

export function toQueryFilters(filters: SearchFilters, today: LocalDate): SearchQueryFilters {
  const period = filters.period ? periodRange(filters.period, today) : null;
  return {
    space: filters.space,
    projectId: filters.projectId,
    kinds: searchedKinds(filters),
    statuses: filters.status ? storedStatuses(filters.status) : null,
    period,
    goalPeriod: period ? { from: addDays(period.from, -6), to: period.to } : null,
  };
}
