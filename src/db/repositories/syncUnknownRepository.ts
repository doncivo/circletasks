import type { SettingKeyScope, SyncColumn, SyncTable } from '../../domain/sync/syncTables';
import type { IsoDateTime } from '../../domain/types';
import type { SqlDriver } from '../driver';

/**
 * Réintégration des champs inconnus devenus connus (ADR 0011, sections 3.2 et 7.2 ; Y-07 critères 6 et 7, décision D3).
 *
 * Après une mise à jour de l'app, une colonne, une table ou une clé de réglage gardée dans `sync_unknown` peut être devenue connue
 * (migration additive). À chaque démarrage, à la fin de `migrate()`, tant que `sync_unknown` n'est pas vide, chaque champ devenu connu
 * est réintégré sous `sync_guard` (aucune entrée dans `sync_outbox`) selon la règle de hlc ordinaire, puis retiré de `sync_unknown`.
 * Les identifiants SQL viennent du seul catalogue ; les noms gardés ne sont jamais que des paramètres liés.
 */

/** Catalogue consulté (celui de l'app par défaut ; étendu d'une colonne de test dans les simulations de mise à jour). */
export interface UnknownCatalogue {
  table(name: string): SyncTable | undefined;
  column(table: string, name: string): SyncColumn | undefined;
  settingScope(key: string): SettingKeyScope;
}

export interface ReintegrateOptions {
  /** Heure de détection des conflits éventuels (`conflict_log.detected_at`). */
  readonly now: IsoDateTime;
  readonly catalogue?: UnknownCatalogue;
  /** Lignes (table, identifiant) traitées par transaction ; 200 par défaut. */
  readonly pageSize?: number;
}

/** Décompte sans contenu (aucun nom ni aucune valeur reçus) : journalisable tel quel. */
export interface ReintegrationReport {
  /** Champs écrits dans leur table (valeur reçue plus récente). */
  readonly reintegrated: number;
  /** Champs retirés sans écriture : valeur locale plus récente (ou égale), ou plus ancienne qu'une purge. */
  readonly superseded: number;
  /** Champs laissés dans `sync_unknown` (encore inconnus, invalides, ou ligne pas encore arrivée). */
  readonly remaining: number;
}

export type ReintegrateUnknownFields = (db: SqlDriver, options: ReintegrateOptions) => Promise<ReintegrationReport>;
