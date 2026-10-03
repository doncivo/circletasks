import { newEntityId, type IdGenerator } from './id';
import type { Checklist, ChecklistItem, ChecklistSummary, NewChecklist, NewChecklistItem } from './model';
import type { ChecklistId, ChecklistItemId, Result } from './types';

/**
 * Règles métier des checklists (M6, C-01 à C-05, complétées story par story). Aucun accès base : les cas d'usage (src/features/checklists) appellent ces fonctions
 * puis écrivent par les repositories.
 */

/** Longueur maximale d'un titre de checklist et d'un élément (C-01 critères 1 et 3). */
export const CHECKLIST_TEXT_MAX = 200;

export type ChecklistTextError = 'empty' | 'tooLong';

/** Texte nettoyé (espaces de bord retirés) ou erreur : 1 à 200 caractères après nettoyage. */
export function validateChecklistText(raw: string): Result<string, ChecklistTextError> {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: 'empty' };
  if (text.length > CHECKLIST_TEXT_MAX) return { ok: false, error: 'tooLong' };
  return { ok: true, value: text };
}

/** Un titre de checklist est-il valide pour activer « Créer » ? */
export function isValidChecklistTitle(raw: string): boolean {
  return validateChecklistText(raw).ok;
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** Tri des checklists par titre, insensible aux accents et à la casse (C-01 critère 4, D3) ; l'id départage les égalités. */
export function compareChecklists(a: Pick<Checklist, 'title' | 'id'>, b: Pick<Checklist, 'title' | 'id'>): number {
  return collator.compare(a.title, b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function sortChecklistSummaries(summaries: readonly ChecklistSummary[]): ChecklistSummary[] {
  return [...summaries].sort((a, b) => compareChecklists(a.checklist, b.checklist));
}

/** Items dans l'ordre manuel (ordre, puis id : stable). */
export function sortItems<T extends Pick<ChecklistItem, 'sortOrder' | 'id'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Ordre manuel d'un nouvel item : en fin de liste (C-01 critère 3). */
export function nextItemOrder(items: readonly Pick<ChecklistItem, 'sortOrder'>[]): number {
  return items.reduce((max, item) => Math.max(max, item.sortOrder), 0) + 1;
}

export interface ChecklistProgress {
  readonly checked: number;
  readonly total: number;
  /** 0 à 1 ; 0 sans item. */
  readonly ratio: number;
}

/** Progression « 3 / 6 » (C-02 critères 1 et 6). */
export function checklistProgress(items: readonly Pick<ChecklistItem, 'checked'>[]): ChecklistProgress {
  const total = items.length;
  const checked = items.filter((item) => item.checked).length;
  return { checked, total, ratio: total === 0 ? 0 : checked / total };
}

/** Suffixe ajouté au titre d'une copie (C-04, D1). */
export const COPY_SUFFIX = ' (copie)';

export interface DuplicatedChecklist {
  readonly checklist: NewChecklist;
  readonly items: readonly NewChecklistItem[];
}

/**
 * « Dupliquer et réinitialiser » (C-04) : « <titre> (copie) », mêmes items dans le même ordre, tous décochés, sans date, même espace
 * et même icône, non modèle. Les items supprimés ne sont pas copiés (l'appelant ne fournit que les items vivants). La copie reçoit
 * de nouveaux identifiants ; l'original n'est pas modifié. Le titre reste dans la limite de 200 caractères.
 */
export function duplicateAndReset(checklist: Pick<Checklist, 'title' | 'spaceId' | 'icon'>, items: readonly ChecklistItem[], ids: IdGenerator): DuplicatedChecklist {
  const id = newEntityId<ChecklistId>(ids);
  const title = `${checklist.title.slice(0, CHECKLIST_TEXT_MAX - COPY_SUFFIX.length)}${COPY_SUFFIX}`;
  return {
    checklist: { id, spaceId: checklist.spaceId, title, icon: checklist.icon, date: null, isTemplate: false },
    items: sortItems(items).map((item, index) => ({
      id: newEntityId<ChecklistItemId>(ids),
      checklistId: id,
      text: item.text,
      checked: false,
      sortOrder: index + 1,
    })),
  };
}
