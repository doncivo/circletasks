import type { SyncValue } from '../../domain/sync/format';
import type { SyncTable } from '../../domain/sync/syncTables';
import type { Hlc, IsoDateTime } from '../../domain/types';

/**
 * Accès aux tables de la synchronisation (ADR 0011, sections 3, 4.3, 5.4, 7.2, 9.1 et 11.2 ; Y-02, Y-05, Y-09).
 *
 * Aucune règle métier : la fusion, la rétention, le choix de l'époque sont dans `src/domain/sync` et orchestrés par `src/sync`. Les
 * identifiants SQL (tables, colonnes) viennent **uniquement** du catalogue (`SyncTable` reçu) ; un nom reçu d'un autre appareil n'est
 * jamais concaténé à une requête : il n'est passé qu'en paramètre lié (`sync_unknown`, `sync_parked`, `conflict_log`).
 */

/** Entrée de la file d'envoi (Y-05). */
export interface OutboxEntry {
  readonly seq: number;
  readonly table: string;
  readonly rowId: string;
  /** Colonne publiée, ou `'*'` (toutes les colonnes publiées, insertion). */
  readonly field: string;
}

/** Entrée publiée : retirée de la file ; si le champ a changé depuis (horloge différente), sa base devient le hlc publié. */
export interface PublishedEntry extends OutboxEntry {
  readonly hlc: Hlc;
}

/** Horloge d'un champ (`sync_field_clock`). */
export interface FieldClock {
  readonly hlc: Hlc;
  readonly base: Hlc | null;
}

/** Ligne lue d'une table publiée : colonnes publiées (catalogue) et colonnes techniques. */
export interface StoredRow {
  readonly id: string;
  readonly values: ReadonlyMap<string, SyncValue>;
  readonly hlc: Hlc;
  readonly updatedAt: IsoDateTime;
}

/** Ligne et ses horloges (instantané, report d'époque). */
export interface ExportedRow extends StoredRow {
  readonly clocks: ReadonlyMap<string, FieldClock>;
}

export interface RowMeta {
  readonly hlc: Hlc;
  readonly updatedAt: IsoDateTime;
  readonly deviceId: string;
}

/** Ligne de `sync_state` (une par appareil, section 3.4). */
export interface SyncStateRow {
  readonly deviceId: string;
  readonly isSelf: boolean;
  readonly platform: string | null;
  readonly appVersion: string | null;
  readonly epoch: string | null;
  readonly cursorSegment: number;
  readonly cursorRecord: number;
  readonly ackHlc: Hlc | null;
  readonly headSegment: number;
  readonly headRecord: number;
  readonly headHlc: Hlc | null;
  readonly stateEpoch: string | null;
  readonly stateSeq: number;
  readonly stateDigest: string | null;
  /** JSON des accusés du dernier état accepté (gardés si l'état devient invalide). */
  readonly lastAcks: string;
  readonly lastSeenHlc: Hlc | null;
  readonly lastSyncAt: IsoDateTime | null;
  readonly schemaVersion: number | null;
  readonly formatMajor: number | null;
  readonly kid: string | null;
  readonly purgeHorizon: Hlc | null;
  readonly snapshotSeq: number | null;
  readonly snapshotHlc: Hlc | null;
  readonly status: string;
}

export type SyncStatePatch = Partial<Omit<SyncStateRow, 'deviceId'>>;

export interface ConflictEntry {
  readonly table: string;
  readonly rowId: string;
  readonly field: string;
  readonly keptValue: SyncValue;
  readonly discardedValue: SyncValue;
  readonly keptDevice: string;
  readonly discardedDevice: string;
  readonly keptHlc: Hlc;
  readonly discardedHlc: Hlc;
}

export interface StoredConflict extends ConflictEntry {
  readonly id: number;
  readonly detectedAt: IsoDateTime;
  readonly resolvedAt: IsoDateTime | null;
  readonly restored: boolean;
}

export interface Tombstone {
  readonly table: string;
  readonly rowId: string;
  readonly deletedHlc: Hlc;
}

export interface UnknownField {
  readonly table: string;
  readonly rowId: string;
  readonly field: string;
  readonly value: SyncValue;
  readonly hlc: Hlc;
  readonly base: Hlc | null;
  readonly sv: number;
}

export type ParkReason = 'missing-parent' | 'missing-row' | 'epoch-carry';

export interface ParkedOp {
  readonly id: number;
  readonly reason: ParkReason;
  readonly table: string;
  readonly rowId: string;
  readonly hlc: Hlc;
  /** Opération complète en JSON (forme d'un `SyncOp` publié). */
  readonly op: string;
}

/** Ligne supprimée candidate à la purge : identifiant, date de suppression et horloge du champ `deleted_at`. */
export interface DeletedRow {
  readonly id: string;
  readonly deletedAt: IsoDateTime;
  readonly deletedHlc: Hlc;
}

/** Élément abandonné par un plafond (journalisé sans contenu, section 1.6). */
export interface DroppedItem {
  readonly kind: 'parked' | 'unknown' | 'conflict';
  readonly table: string;
  readonly rowId: string;
  readonly reason: string;
}

export interface SyncRepository {
  // --- garde (section 3.2, audit M10) ---------------------------------------------------------------------------------------------
  /** Y-02 : pose la garde ; à appeler en tête d'une transaction, retirée par `clearGuard` avant le COMMIT (un ROLLBACK la retire aussi). */
  setGuard(): Promise<void>;
  clearGuard(): Promise<void>;
  /** Y-02 : vérifie la garde au démarrage et après une restauration ; supprime les lignes trouvées et renvoie leur nombre. */
  assertGuardEmpty(): Promise<number>;

  // --- file d'envoi (Y-05) --------------------------------------------------------------------------------------------------------
  /** Y-05 : entrées de la file, par numéro croissant (numéro strictement supérieur à `afterSeq`, 0 par défaut). */
  readOutbox(limit?: number, afterSeq?: number): Promise<OutboxEntry[]>;
  outboxCount(): Promise<number>;
  /** Y-02 : retire les entrées publiées (même numéro) ; base des champs modifiés depuis = hlc publié. */
  clearPublished(entries: readonly PublishedEntry[]): Promise<void>;
  /**
   * Y-05 : retire des entrées lues sans rien à publier (ligne disparue, valeur d'un autre appareil), **par numéro** : une écriture faite
   * depuis la lecture a reçu un nouveau numéro et reste dans la file.
   */
  dropOutbox(entries: readonly Pick<OutboxEntry, 'seq'>[]): Promise<void>;
  /** Y-02 : retire les champs en attente écrasés par une valeur distante plus récente (dans la transaction gardée de l'application). */
  dropPending(entries: readonly Pick<OutboxEntry, 'table' | 'rowId' | 'field'>[]): Promise<void>;
  /** Y-02 (« Appliquer partout ») : file vidée, l'instantané contient tout. */
  clearOutbox(uptoSeq?: number): Promise<void>;
  /** Y-02 (section 9.1 (c)) : remet un champ dans la file. */
  addOutbox(entries: readonly Pick<OutboxEntry, 'table' | 'rowId' | 'field'>[]): Promise<void>;
  maxOutboxSeq(): Promise<number>;

  // --- lignes des tables publiées ------------------------------------------------------------------------------------------------
  /** Y-02 : lignes (colonnes publiées du catalogue) ; lignes supprimées comprises. */
  readRows(table: SyncTable, ids: readonly string[]): Promise<Map<string, StoredRow>>;
  /** Y-02 : horloges de champ des lignes. */
  readClocks(table: SyncTable, ids: readonly string[]): Promise<Map<string, Map<string, FieldClock>>>;
  /** Y-05 : lignes et leurs horloges lues par une seule instruction (valeurs et horloges cohérentes, publication). */
  readRowsWithClocks(table: SyncTable, ids: readonly string[]): Promise<Map<string, ExportedRow>>;
  /** Y-02 : champs en attente de publication (`'*'` compris). */
  pendingFields(table: SyncTable, ids: readonly string[]): Promise<Map<string, Set<string>>>;
  /** Y-02 : identifiants existants parmi ceux donnés (contrôle des parents). */
  existingIds(table: SyncTable, ids: readonly string[]): Promise<Set<string>>;
  insertRow(table: SyncTable, id: string, values: ReadonlyMap<string, SyncValue>, meta: RowMeta): Promise<void>;
  updateRow(table: SyncTable, id: string, values: ReadonlyMap<string, SyncValue>, meta: RowMeta | null): Promise<void>;
  /** Remplace les valeurs publiées et les horloges d'une ligne (remplacement par un instantané, section 9.1 (b)). */
  writeClocks(table: SyncTable, id: string, clocks: readonly { readonly field: string; readonly hlc: Hlc; readonly base: Hlc | null }[]): Promise<void>;
  replaceClocks(table: SyncTable, id: string, clocks: readonly { readonly field: string; readonly hlc: Hlc; readonly base: Hlc | null }[]): Promise<void>;
  /** Y-02 : page de lignes par identifiant croissant, avec leurs horloges lues par la même instruction (instantané, report d'époque, section 9.1 (a)). */
  exportRows(table: SyncTable, afterId: string | null, limit: number): Promise<ExportedRow[]>;
  /** Y-09 : supprime physiquement des lignes, leurs horloges, leurs entrées de file (sous garde ; aucune trace écrite ici). */
  deleteRows(table: SyncTable, ids: readonly string[]): Promise<void>;
  /** Y-09 : lignes supprimées avant `before` et sans enfant (clés du catalogue), avec l'horloge de `deleted_at`, par identifiant croissant après `afterId`. */
  deletedRows(table: SyncTable, before: IsoDateTime, limit: number, afterId?: string | null): Promise<DeletedRow[]>;
  /** Y-09 : identifiants, parmi ceux donnés, qui ont encore au moins une ligne enfant (clés du catalogue) : jamais purgés. */
  withChildren(table: SyncTable, ids: readonly string[]): Promise<Set<string>>;
  /**
   * Y-09 (décision (c), question ouverte 10 de l'ADR 0011) : les lignes enfants **vivantes** de `table` dont `column` (colonne nullable)
   * vise un des parents donnés perdent ce lien (`NULL`, « Sans projet ») par une écriture locale tamponnée, et sont mises dans la file
   * en ligne entière (`'+'`). À appeler sous garde ; renvoie les identifiants rattachés.
   */
  detachLiveChildren(table: SyncTable, column: string, parentIds: readonly string[]): Promise<string[]>;
  /** Même écriture locale pour une ligne donnée (ligne reçue dont le parent de `column` est purgé ici, décision (c)). Sous garde. */
  detachField(table: SyncTable, id: string, column: string): Promise<void>;
  /** Y-09 (T-08) : rappels qui visent les lignes données (`target_type`, `target_id`), avec leur hlc ; purgés avec elles. */
  targetReminders(targetType: string, targetIds: readonly string[]): Promise<{ readonly id: string; readonly targetId: string; readonly hlc: Hlc }[]>;
  /** Plus grand hlc présent (tables publiées), pour l'horloge locale. */
  maxRowHlc(): Promise<Hlc | null>;

  // --- état et curseurs (section 3.4) ---------------------------------------------------------------------------------------------
  getStates(): Promise<SyncStateRow[]>;
  /** Crée ou met à jour la ligne d'un appareil (champs donnés seulement). */
  saveState(deviceId: string, patch: SyncStatePatch): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;

  // --- conflits (section 4.3) -----------------------------------------------------------------------------------------------------
  /** Un conflit déjà inscrit (même ligne, même champ, mêmes hlc gardé et écarté) n'est pas inscrit deux fois (rejeu). */
  insertConflicts(conflicts: readonly ConflictEntry[], detectedAt: IsoDateTime): Promise<void>;
  countConflictsSince(since: IsoDateTime): Promise<number>;
  listConflicts(since: IsoDateTime, limit: number): Promise<StoredConflict[]>;

  // --- traces (section 5.4) --------------------------------------------------------------------------------------------------------
  tombstones(table: string, ids: readonly string[]): Promise<Map<string, Hlc>>;
  insertTombstones(items: readonly Tombstone[], purgedAt: IsoDateTime): Promise<void>;
  removeTombstone(table: string, rowId: string): Promise<void>;
  exportTombstones(after: { readonly table: string; readonly rowId: string } | null, limit: number): Promise<Tombstone[]>;
  tombstoneCount(): Promise<number>;
  clearTombstones(): Promise<void>;

  // --- champs inconnus (section 7.2) ----------------------------------------------------------------------------------------------
  /** Garde la valeur au plus grand hlc (règle ordinaire) ; renvoie vrai si elle a été écrite. */
  putUnknown(field: UnknownField): Promise<boolean>;
  /** Page de champs inconnus par `rowid` croissant strictement supérieur à `afterRowid` (0 : depuis le début). */
  exportUnknown(afterRowid: number, limit: number): Promise<(UnknownField & { readonly rowid: number })[]>;
  clearUnknown(): Promise<void>;

  // --- opérations mises de côté ---------------------------------------------------------------------------------------------------
  park(reason: ParkReason, table: string, rowId: string, hlc: Hlc, op: string, at: IsoDateTime): Promise<void>;
  parked(reasons: readonly ParkReason[], afterId: number, limit: number): Promise<ParkedOp[]>;
  /** Opérations mises de côté pour une ligne (recomposition d'une ligne publiée en plusieurs opérations). */
  parkedForRow(reason: ParkReason, table: string, rowId: string): Promise<ParkedOp[]>;
  removeParked(ids: readonly number[]): Promise<void>;
  parkedCount(reasons: readonly ParkReason[]): Promise<number>;

  // --- plafonds (section 1.6) -----------------------------------------------------------------------------------------------------
  /** Applique les plafonds de `sync_parked` (hors `epoch-carry`), `sync_unknown` et `conflict_log` ; renvoie les éléments abandonnés. */
  enforceCaps(caps: {
    readonly parked: number;
    readonly unknownFields: number;
    readonly unknownBytes: number;
    readonly conflicts: number;
    readonly conflictsBefore: IsoDateTime;
  }): Promise<DroppedItem[]>;

  // --- réparations (section 8) ----------------------------------------------------------------------------------------------------
  /** Périodes de pause des routines données. */
  routinePauses(routineIds: readonly string[]): Promise<Map<string, { readonly toDate: string | null; readonly deletedAt: string | null }[]>>;
  /** Colonne locale `routine.paused` (sans tampon : jamais publiée). */
  setRoutinePaused(routineId: string, paused: boolean): Promise<void>;
  openFocusSessions(): Promise<{ readonly id: string; readonly startedAt: IsoDateTime; readonly hlc: Hlc }[]>;
  /** Écriture locale tamponnée (publiée) : clôture d'une session Focus. */
  closeFocusSession(id: string, endedAt: IsoDateTime): Promise<void>;
  /** Cache local des événements d'un compte supprimé physiquement (table locale `external_event`). */
  deleteExternalEventsOf(accountIds: readonly string[]): Promise<void>;
}
