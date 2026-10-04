import type { ItemFilter } from '../../domain/itemFilter';
import type { GoalsCount, WeekCount } from '../../domain/monthReport';
import type { LocalDate } from '../../domain/types';
import type { DateRange } from './common';

/** Plage de dates locales et filtre d'espace / projet (ES-08) des agrégats de statistiques. */
export interface StatsQuery {
  readonly range: DateRange;
  readonly filter: ItemFilter;
}

/**
 * Statistiques (M11, H-01 à H-03) : agrégats calculés par SQLite (COUNT / GROUP BY), jamais en lisant toutes les lignes. Aucune règle
 * métier ici : les bornes (pas de date future), les semaines et les pourcentages sont dans `src/domain/monthReport.ts`.
 */
export interface StatsRepository {
  /**
   * H-01, H-02 : tâches datées de la plage (hors « Un jour », supprimées et écartées exclues), groupées par semaine ISO (lundi) avec
   * leur nombre total et de terminées. Espace : celui de la tâche ; projet : celui de la tâche (ES-08), une tâche sans projet n'est
   * comptée que sous « Tous les projets ». Semaines sans tâche absentes du résultat.
   */
  taskCountsByWeek(query: StatsQuery): Promise<WeekCount[]>;
  /**
   * H-01 : objectifs dont la semaine commence dans la plage, atteints / total (supprimés exclus). Un objectif n'a pas de projet : sous un
   * filtre de projet, aucun n'est compté (ES-08 critère 4).
   */
  goalCounts(query: StatsQuery): Promise<GoalsCount>;
  /**
   * H-01 critère 2 : date de la plus ancienne donnée (tâche datée hors « Un jour », validation de routine, objectif, session Focus
   * terminée), tous espaces confondus ; null si la base est vide.
   */
  oldestActivity(): Promise<LocalDate | null>;
}
