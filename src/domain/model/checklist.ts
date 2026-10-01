import type { ChecklistId, ChecklistItemId, LocalDate, SpaceId, SyncMeta } from '../types';

/**
 * Checklist (M6, ordre 2) — forme minimale posée à l'ordre 1 pour l'affichage
 * « Valise 3/5 » dans Aujourd'hui (A-01). Complétée par checklists-events.
 */
export interface Checklist extends SyncMeta {
  readonly id: ChecklistId;
  readonly spaceId: SpaceId;
  readonly title: string;
  /** Jour auquel la checklist est associée (C-03), sinon null. */
  readonly date: LocalDate | null;
  readonly isTemplate: boolean;
}

export interface ChecklistItem extends SyncMeta {
  readonly id: ChecklistItemId;
  readonly checklistId: ChecklistId;
  readonly text: string;
  readonly checked: boolean;
  readonly sortOrder: number;
}

/** Ligne d'Aujourd'hui / Semaine : checklist et progression (C-02). */
export interface ChecklistSummary {
  readonly checklist: Checklist;
  readonly checked: number;
  readonly total: number;
}
