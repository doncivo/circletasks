/**
 * Y-TECH-05 : parties du compte rendu du report d'époque lues par l'écran, le bandeau et « J'ai vu » (blocs à la demande de l'interface) :
 * constantes, correspondance table → libellé et type, compteurs, copie de la notice. Module pur **sans import d'exécution** (types seulement) :
 * les règles de constitution (`epochCarryReport.ts`, qui importe l'analyse des horloges) restent hors de ces blocs, pour ne pas ajouter de
 * dépendance partagée au JavaScript de départ (plafond du bundle, règle d'Ali du 2026-10-18). `epochCarryReport.ts` les réexporte.
 */

import type { EpochCarryNotice } from './epochCarryNotice';
import type { EpochCarryReportBody } from './epochCarryReport';
import type { SyncTableName } from './syncTables';

/** Comptes rendus gardés : au-delà, les plus anciens **acquittés** sont supprimés ; un non acquitté ne l'est jamais. */
export const EPOCH_CARRY_REPORT_KEEP = 20;
/** Clé de `sync_meta` (locale) : le compte rendu d'un report n'a pas pu être enregistré (persistant : levé tant que « J'ai vu » ne l'a pas effacée, jamais effacé par le moteur ni par un compte rendu suivant). */
export const EPOCH_CARRY_REPORT_FAILED_META = 'epochCarryReportFailed';
/** Journal technique (code d'erreur seulement) : lecture du compte rendu (avertissement `carry-report`) impossible dans un cycle ; le cycle continue, l'avertissement est levé. */
export const EPOCH_CARRY_REPORT_READ_FAILED_EVENT = 'epoch-carry-report-read-failed';
/**
 * Correspondance unique table publiée → colonne de libellé (null : aucune, repli) et clé du type d'élément en français (`kind`, clé de
 * texte du catalogue i18n de l'écran : « Tâche », « Projet »… ; aucun texte ici, CLAUDE.md « textes dans src/i18n »). Un test échoue si
 * une table du catalogue de synchro manque.
 */
export const CARRY_REPORT_TABLES: { readonly [K in SyncTableName]: { readonly label: string | null; readonly kind: string } } = {
  space: { label: 'name', kind: 'space' },
  project: { label: 'name', kind: 'project' },
  recurrence: { label: null, kind: 'recurrence' },
  goal: { label: 'title', kind: 'goal' },
  task: { label: 'title', kind: 'task' },
  routine: { label: 'title', kind: 'routine' },
  routine_log: { label: null, kind: 'routineLog' },
  routine_pause: { label: null, kind: 'routinePause' },
  reminder: { label: null, kind: 'reminder' },
  event: { label: 'title', kind: 'event' },
  checklist: { label: 'title', kind: 'checklist' },
  checklist_item: { label: 'text', kind: 'checklistItem' },
  focus_session: { label: null, kind: 'focusSession' },
  calendar_account: { label: 'label', kind: 'calendarAccount' },
  holiday: { label: 'name', kind: 'holiday' },
  settings: { label: null, kind: 'settings' },
};

export const carryReportTableEntry = (table: string): { readonly label: string | null; readonly kind: string } | undefined =>
  Object.prototype.hasOwnProperty.call(CARRY_REPORT_TABLES, table) ? CARRY_REPORT_TABLES[table as SyncTableName] : undefined;

/** Identifiant abrégé du repli « (sans titre) » : 8 premiers caractères. */
export function shortRowId(rowId: string): string {
  return rowId.slice(0, 8);
}

/** Clé du type d'élément (« Tâche »…) ; table inconnue : `other`. */
export function carryReportKind(table: string): string {
  return carryReportTableEntry(table)?.kind ?? 'other';
}

/** Nombre total d'écritures reportées (champs, traces, tardives) : zéro, aucun bandeau (critère 8). */
export function carriedWrites(body: Pick<EpochCarryReportBody, 'authors'>): number {
  return body.authors.reduce((sum, a) => sum + a.fields + a.tombs + a.late, 0);
}

/** Lignes nommées (listes et débordement). */
export function namedCount(body: Omit<EpochCarryReportBody, 'authors'>): number {
  return body.restored.length + body.recreated.length + body.parentReplaced.length + body.overflow;
}

/** Lignes **rétablies** (supprimées chez soi, rendues vivantes), débordement compris : le seul nombre de « Éléments rétablis : {n} » (ADR 0011 §29 point 5). */
export function restoredCount(body: Pick<EpochCarryReportBody, 'restored' | 'overflowBy'>): number {
  return body.restored.length + body.overflowBy.restored;
}

/** Lignes recréées, débordement compris. */
export function recreatedCount(body: Pick<EpochCarryReportBody, 'recreated' | 'overflowBy'>): number {
  return body.recreated.length + body.overflowBy.recreated;
}

/** Lignes rattachées ou mises de côté (parent remplacé), débordement compris. */
export function parentReplacedCount(body: Pick<EpochCarryReportBody, 'parentReplaced' | 'overflowBy'>): number {
  return body.parentReplaced.length + body.overflowBy.parentReplaced;
}

/**
 * « J'ai vu » d'un compte rendu (phase 2) : quand plus aucun compte rendu non acquitté ne nomme de ligne rattachée, la notice perd ses
 * lignes **rattachées** (`carry-reattached` disparaît) ; les lignes mises de côté restent (`carry-held` dure tant qu'elles attendent :
 * Y-FIX-04 critère 13 b). Null si elle ne nomme plus rien.
 */
export function noticeAfterAcknowledge(notice: EpochCarryNotice | null, unacknowledged: readonly Pick<EpochCarryReportBody, 'parentReplaced'>[]): EpochCarryNotice | null {
  if (!notice) return null;
  if (unacknowledged.some((r) => r.parentReplaced.some((item) => item.kind === 'reattached'))) return notice;
  return notice.held.length === 0 ? null : { ...notice, reattached: [], overflow: 0 };
}
