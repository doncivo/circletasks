import type { ChecklistId, ChecklistItemId, LocalDate, SpaceId, SyncMeta } from '../types';
import type { IconRef } from './icon';

/**
 * Checklist (M6, PRD 6). Table `checklist`.
 * - `date` : jour auquel la checklist est associée (C-03), sinon null ;
 * - `isTemplate` : modèle réutilisable (C-04) ;
 * - `icon` : icône ou emoji (C-01, migration 0008) ; null = icône « liste » par défaut.
 */
export interface Checklist extends SyncMeta {
  readonly id: ChecklistId;
  readonly spaceId: SpaceId;
  readonly title: string;
  readonly icon: IconRef | null;
  readonly date: LocalDate | null;
  readonly isTemplate: boolean;
}

export type ChecklistFields = Omit<Checklist, keyof SyncMeta>;
export type NewChecklist = ChecklistFields & { readonly id: ChecklistId };
/** Champs modifiables d'une checklist (la date passe par `setDate`). */
export type ChecklistPatch = Partial<Pick<ChecklistFields, 'title' | 'icon' | 'spaceId' | 'isTemplate'>>;

/** Élément d'une checklist. Table `checklist_item` ; `sortOrder` : ordre manuel (les cochés restent à leur place, C-02). */
export interface ChecklistItem extends SyncMeta {
  readonly id: ChecklistItemId;
  readonly checklistId: ChecklistId;
  readonly text: string;
  readonly checked: boolean;
  readonly sortOrder: number;
}

export type ChecklistItemFields = Omit<ChecklistItem, keyof SyncMeta>;
export type NewChecklistItem = ChecklistItemFields & { readonly id: ChecklistItemId };

/** Ligne d'Aujourd'hui / Semaine / liste des checklists : checklist et progression (C-02). */
export interface ChecklistSummary {
  readonly checklist: Checklist;
  readonly checked: number;
  readonly total: number;
}
