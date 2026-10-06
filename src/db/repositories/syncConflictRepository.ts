import type { ConflictRowState } from '../../domain/sync/conflictRestore';
import type { SyncValue } from '../../domain/sync/format';
import type { SyncColumn, SyncTable } from '../../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../../domain/types';
import type { StoredConflict } from './syncRepository';

/**
 * Journal des conflits : lecture pour l'écran et restauration de la valeur écartée (ADR 0011, section 4.3 ; Y-04).
 *
 * Aucune règle métier (choix de la restauration, refus, annulation : `src/features/sync/syncConflictUseCases.ts`). Les identifiants SQL
 * (tables, colonnes) sont **ceux du catalogue** reçus en `SyncTable` / `SyncColumn` : le texte d'une ligne de `conflict_log` (qui vient
 * d'un journal reçu) n'est jamais concaténé à une requête ; il n'est passé qu'en paramètre lié. Les lectures de `conflict_log`
 * (`listConflicts`, `countConflictsSince`) restent celles de `SyncRepository` (Y-02).
 */

/** État d'une ligne visée par un conflit (ou d'un parent visé par une valeur) : règle du domaine. */
export type { ConflictRowState };

/** Ligne de `conflict_log` lue pour l'écran : le conflit, ou null si son contenu est illisible (isolée, signalée). */
export interface ConflictLogEntry {
  readonly id: number;
  readonly conflict: StoredConflict | null;
}

/** Élément à décrire : table du catalogue et identifiant. */
export interface ConflictTarget {
  readonly table: SyncTable;
  readonly rowId: string;
}

/** Ce que l'écran montre d'un élément : son titre lu au moment de l'affichage (null : pas de titre propre) et son état. */
export interface ConflictItemInfo {
  readonly state: ConflictRowState;
  readonly title: string | null;
}

/** Valeur courante d'un champ et son horloge (champ, sinon `'*'`, sinon hlc de la ligne ; section 3.2). */
export interface ConflictFieldState {
  readonly row: ConflictRowState;
  readonly value: SyncValue;
  readonly hlc: Hlc | null;
}

export interface SyncConflictRepository {
  /** Y-04 : un conflit par son numéro ; null s'il n'existe plus (plafond, 12 mois) ; `'unreadable'` si son contenu est illisible. */
  getConflict(id: number): Promise<StoredConflict | 'unreadable' | null>;
  /**
   * Y-04 : conflits détectés depuis `since`, du plus récent au plus ancien, `limit` au plus. Une ligne illisible (JSON altéré) ne fait
   * pas échouer la lecture : elle revient sans conflit, pour être signalée (`listConflicts` de Y-02 échoue en bloc).
   */
  listLog(since: IsoDateTime, limit: number): Promise<ConflictLogEntry[]>;
  /** Y-04 : titre et état de chaque élément (clé `<table>|<id>`) ; tables et colonnes du catalogue seulement. */
  describe(targets: readonly ConflictTarget[]): Promise<Map<string, ConflictItemInfo>>;
  /** Y-04 : état d'une ligne (vivante, supprimée, absente, purgée : trace dans `sync_tombstone`). */
  rowState(table: SyncTable, rowId: string): Promise<ConflictRowState>;
  /** Y-04 : valeur courante d'un champ publié et son horloge. */
  fieldState(table: SyncTable, column: SyncColumn, rowId: string): Promise<ConflictFieldState>;
  /**
   * Y-04 : écriture locale d'un champ par le `WriteStamper` (jamais un hlc forgé) ; les déclencheurs de Y-02 posent l'horloge du
   * champ (base = horloge courante) et l'entrée de `sync_outbox`. Renvoie le hlc de l'écriture.
   */
  writeField(table: SyncTable, column: SyncColumn, rowId: string, value: SyncValue): Promise<Hlc>;
  /** Y-04 : `restored = 1`, `resolved_at = at` ; `at` null : `restored = 0`, `resolved_at = NULL` (annulation). */
  markRestored(id: number, at: IsoDateTime | null): Promise<void>;
}

// Exposé par `Repositories.syncConflicts` (bloc « Y-04 » de `sql/index.ts`) sans toucher `dataAccess.ts` (fichier partagé du lot Y3).
declare module './dataAccess' {
  interface Repositories {
    /** Journal des conflits (Y-04). */
    readonly syncConflicts: SyncConflictRepository;
  }
}
