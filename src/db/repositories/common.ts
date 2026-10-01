import type { Id, IsoDateTime, LocalDate } from '../../domain/types';

/**
 * Règles communes à tous les repositories (ADR 0004) — à respecter par data-model :
 *
 * 1. Lecture : les lignes supprimées (`deleted_at` non null) sont exclues, sauf
 *    option `includeDeleted` ou méthode dédiée (corbeille).
 * 2. Filtre d'espace : `SpaceFilter` = un `SpaceId` (colonne `space_id`) ou 'all'.
 * 3. Écriture : chaque ligne insérée ou modifiée reçoit UN tampon `WriteStamper.next()`
 *    (`created_at` à l'insertion, `updated_at`, `device_id`, `hlc`) ; un repository ne
 *    lit jamais l'horloge ni ne fabrique d'identifiant : l'id arrive dans l'entrée.
 * 4. Retour : toute écriture renvoie l'entité telle qu'enregistrée (avec son nouveau hlc),
 *    ce qui sert à l'UI et aux commandes d'annulation.
 * 5. Ligne absente ou supprimée lors d'un update : `RepositoryError('not-found')`.
 * 6. Aucune règle métier (pas de calcul de date, pas de valeur par défaut métier) :
 *    elles vivent dans src/domain et sont appliquées par les cas d'usage.
 * 7. Conversion snake_case ↔ camelCase, booléens 0/1, JSON texte, icône via
 *    `encodeIcon` / `parseIcon` : dans le repository uniquement.
 * 8. Écritures multiples d'un même cas d'usage : `DataAccess.transaction` ; dans la
 *    transaction, n'utiliser QUE les repositories reçus en paramètre (ADR 0002).
 */

/** Plage de dates locales, bornes incluses. */
export interface DateRange {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/** Plage d'instants UTC, `from` inclus, `to` exclu. */
export interface InstantRange {
  readonly from: IsoDateTime;
  readonly to: IsoDateTime;
}

export interface ReadOptions {
  readonly includeDeleted?: boolean;
}

/** Nouvel ordre manuel d'éléments (A-02, SD-04, ES-04). */
export interface SortOrderEntry<TId extends Id> {
  readonly id: TId;
  readonly sortOrder: number;
}

export type RepositoryErrorCode = 'not-found';

export class RepositoryError extends Error {
  override readonly name = 'RepositoryError';
  readonly code: RepositoryErrorCode;
  readonly entity: string;
  readonly entityId: string;

  constructor(code: RepositoryErrorCode, entity: string, entityId: string) {
    super(`${entity} ${entityId} : ${code}`);
    this.code = code;
    this.entity = entity;
    this.entityId = entityId;
  }
}
