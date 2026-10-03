import type { Checklist, ChecklistItem, ChecklistSummary } from './model';
import type { Result } from './types';

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
