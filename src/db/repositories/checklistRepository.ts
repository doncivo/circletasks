import type { Checklist, ChecklistItem, ChecklistPatch, ChecklistSummary, NewChecklist, NewChecklistItem } from '../../domain/model';
import type { ChecklistId, ChecklistItemId, LocalDate, SpaceFilter } from '../../domain/types';
import type { DateRange, ReadOptions, SortOrderEntry } from './common';

/**
 * Checklists (M6, C-01 à C-05). La suppression est logique : elle ne touche que la ligne `checklist` ; ses items gardent leur état et
 * disparaissent des lectures tant que la checklist l'est (restaurer la checklist les restaure). Aucune règle métier ici (titres, copie,
 * ordre) : `src/domain/checklistRules.ts`.
 */
export interface ChecklistRepository {
  getById(id: ChecklistId, options?: ReadOptions): Promise<Checklist | null>;
  /** C-01 : checklists du filtre d'espace (modèles compris) avec progression « cochés / total » ; tri par titre. */
  listSummaries(filter: SpaceFilter): Promise<ChecklistSummary[]>;
  /** C-03 : checklists associées à un jour (hors modèles), avec progression « 3/5 ». */
  listSummariesForDay(date: LocalDate, filter: SpaceFilter): Promise<ChecklistSummary[]>;
  listSummariesForRange(range: DateRange, filter: SpaceFilter): Promise<ChecklistSummary[]>;
  /** C-01. */
  create(checklist: NewChecklist): Promise<Checklist>;
  /**
   * C-04 : crée une checklist et tous ses items. À appeler dans `DataAccess.transaction` : une erreur n'y laisse aucune copie partielle.
   * Les items sont insérés par lots (200 items en quelques requêtes).
   */
  createWithItems(checklist: NewChecklist, items: readonly NewChecklistItem[]): Promise<{ readonly checklist: Checklist; readonly items: ChecklistItem[] }>;
  /** C-01 (titre, icône, espace), C-04 (modèle). */
  update(id: ChecklistId, patch: ChecklistPatch): Promise<Checklist>;
  /** C-03 : pose (`date`) ou retire (null) le jour associé. */
  setDate(id: ChecklistId, date: LocalDate | null): Promise<Checklist>;
  softDelete(id: ChecklistId): Promise<Checklist>;
  restore(id: ChecklistId): Promise<Checklist>;
}

export interface ChecklistItemRepository {
  /** Items vivants d'une checklist, dans l'ordre manuel. */
  listForChecklist(checklistId: ChecklistId): Promise<ChecklistItem[]>;
  /** Items demandés, supprimés compris (annulation d'un lot) ; ordre des identifiants, ceux qui n'existent pas sont omis. */
  getByIds(ids: readonly ChecklistItemId[]): Promise<ChecklistItem[]>;
  /** C-01 : ajoute un item (le texte est déjà validé par le domaine). */
  add(item: NewChecklistItem): Promise<ChecklistItem>;
  /** C-02 : état voulu (et non « basculer »). */
  setChecked(id: ChecklistItemId, checked: boolean): Promise<ChecklistItem>;
  /** C-05 : « Tout décocher » et son annulation, en un lot ; chaque item reçoit son tampon. */
  setCheckedMany(ids: readonly ChecklistItemId[], checked: boolean): Promise<ChecklistItem[]>;
  /** C-02 : texte modifié en ligne. */
  rename(id: ChecklistItemId, text: string): Promise<ChecklistItem>;
  /** C-05 : ordre manuel. */
  setSortOrders(entries: readonly SortOrderEntry<ChecklistItemId>[]): Promise<void>;
  /** C-05 : suppression logique d'un lot (« Effacer les cochés », « − »). */
  softDelete(ids: readonly ChecklistItemId[]): Promise<ChecklistItem[]>;
  restore(ids: readonly ChecklistItemId[]): Promise<ChecklistItem[]>;
}
