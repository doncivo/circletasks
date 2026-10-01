import type { LocalDate, RecurrenceId, SyncMeta, Weekday } from '../types';

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Nᵉ jour de semaine du mois (« 2ᵉ lundi ») ; `nth = -1` : dernier du mois. */
export interface NthWeekday {
  readonly nth: 1 | 2 | 3 | 4 | 5 | -1;
  readonly weekday: Weekday;
}

/**
 * Règle de récurrence d'une tâche (T-09, T-10). Table `recurrence`.
 * Une tâche récurrente ne stocke que l'occurrence en cours ; la suivante est créée
 * quand elle est terminée ou passée (PRD 6, calcul : domain-logic).
 *
 * Invariants (validés dans src/domain par domain-logic) :
 * - `interval` ≥ 1 (tous les N jours / semaines / mois / ans) ;
 * - `weekly` : `weekdays` non vide ;
 * - `monthly` : exactement un de `monthDay` (1–31, borné au dernier jour du mois) ou `nthWeekday` ;
 * - `until` et `count` exclusifs (fin à une date ou après N occurrences), ou tous deux null.
 */
export interface Recurrence extends SyncMeta {
  readonly id: RecurrenceId;
  readonly freq: RecurrenceFreq;
  readonly interval: number;
  readonly weekdays: readonly Weekday[];
  readonly monthDay: number | null;
  readonly nthWeekday: NthWeekday | null;
  readonly until: LocalDate | null;
  readonly count: number | null;
}

export type RecurrenceFields = Omit<Recurrence, keyof SyncMeta>;
export type NewRecurrence = RecurrenceFields & { readonly id: RecurrenceId };
export type RecurrencePatch = Partial<RecurrenceFields>;
