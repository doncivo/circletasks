import type { EpochCarryReport, EpochCarryReportBody, EpochCarryReportHead } from '../../domain/sync/epochCarryReport';
import type { IsoDateTime } from '../../domain/types';

/**
 * Y-TECH-05 : comptes rendus du report d'époque (table locale `epoch_carry_report`, migration 0019, jamais publiée). Aucune règle métier :
 * classement, bornes et bandeau dans `src/domain/sync/epochCarryReport.ts`. Implémentation chargée **à la demande**
 * (`sql/epochCarryReports.ts`) : `Repositories.carryReports()` ne coûte au départ qu'un import dynamique.
 */
export interface EpochCarryReportRepository {
  /** Nouveau compte rendu (compteurs et listes vides, bandeau faux) ; renvoie son identifiant. */
  create(head: EpochCarryReportHead): Promise<number>;
  get(id: number): Promise<EpochCarryReport | null>;
  /** Compteurs, listes, débordement et attribut « bandeau » remplacés (écrit dans la transaction de la page de `reapply`). */
  save(id: number, body: EpochCarryReportBody, banner: boolean): Promise<void>;
  /** Les `limit` plus récents, du plus récent au plus ancien (historique de Détails). */
  list(limit: number): Promise<EpochCarryReport[]>;
  /** Comptes rendus non acquittés, du plus récent au plus ancien. */
  unacknowledged(): Promise<EpochCarryReport[]>;
  /** « J'ai vu » : `acknowledged_at = at` si le compte rendu n'était pas acquitté ; vrai s'il l'a été par cet appel. */
  acknowledge(id: number, at: IsoDateTime): Promise<boolean>;
  /** Supprime les comptes rendus **acquittés** hors des `keep` plus récents ; un non acquitté n'est jamais supprimé. Renvoie le nombre supprimé. */
  prune(keep: number): Promise<number>;
}

// Exposé par `Repositories.carryReports` (bloc « Y-TECH-05 » de `sql/index.ts`) : fabrique à la demande, liée à l'exécuteur (driver ou transaction).
declare module './dataAccess' {
  interface Repositories {
    /** Comptes rendus du report d'époque (Y-TECH-05), chargés à la demande. */
    readonly carryReports: () => Promise<EpochCarryReportRepository>;
  }
}
