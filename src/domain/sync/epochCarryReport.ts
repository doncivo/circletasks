/**
 * Y-TECH-05 (ADR 0011 §24 point 6, §26, §28) : compte rendu visible du report d'époque, établi par l'appareil qui reporte (`B`) à l'étape
 * (c) `reapply` du changement d'époque (`src/sync/epochSwitch.ts`). Décision d'Ali (2026-10-17) : « combien d'écritures reportées, par quel
 * appareil, et surtout la liste nommée de ce qui a été rétabli alors que je l'avais supprimé ».
 *
 * Module pur (règles de classement, correspondance table → libellé, bornes, ordre, bandeau) ; aucune I/O. Importé seulement par des modules
 * chargés à la demande (`epochSwitch.ts`, dépôt `sql/epochCarryReports.ts`, écran de détail) : hors du JavaScript de départ.
 *
 * Définitions (fiche Y-TECH-05, « Décisions retenues »), pour une ligne reportée :
 * - **rétablie** : supprimée dans la base juste après l'étape (b) (`deleted_at` non nul, ou trace dans `sync_tombstone`), vivante après
 *   l'application de son report ;
 * - **recréée** : absente de la base remplacée (ni ligne ni trace), rendue vivante par son report (entrée `'+'`) ;
 * - **reportée** (compteurs seulement) : tout champ, toute ligne et toute trace purgée dont le report est passé par (c).
 * Une ligne vivante avant et après n'est dans aucune liste ; une suppression de l'ouvreur annulée par la restauration (ligne vivante dans
 * la sauvegarde) n'est donc jamais « rétablie ». En fusion (réinitialisation Y-11), rien n'est remplacé : aucune liste n'est tenue.
 */

import type { DeviceId, Hlc, IsoDateTime } from '../types';
import type { EpochCarryNotice, EpochCarryNoticeItem } from './epochCarryNotice';
import { hlcDevice, hlcIso } from './parse';
import { SYNC_TABLES, type SyncTableName } from './syncTables';

/** Lignes nommées gardées par compte rendu (toutes listes) ; le reste est compté dans `overflow`. */
export const EPOCH_CARRY_REPORT_MAX_NAMED = 500;
/** Comptes rendus gardés : au-delà, les plus anciens **acquittés** sont supprimés ; un non acquitté ne l'est jamais. */
export const EPOCH_CARRY_REPORT_KEEP = 20;
/** Clé de `sync_meta` (locale) : le compte rendu d'un report n'a pas pu être enregistré (persistant, levé jusqu'au compte rendu suivant). */
export const EPOCH_CARRY_REPORT_FAILED_META = 'epochCarryReportFailed';
/** Événement du journal technique en cas d'échec d'écriture (code d'erreur seulement, jamais un libellé). */
export const EPOCH_CARRY_REPORT_FAILED_EVENT = 'epoch-carry-report-failed';

/**
 * Auteur des lignes de l'amorce (espaces Pro et Perso, identiques sur chaque appareil : `SEED_DEVICE_ID` de `src/db/seed`, égalité testée) :
 * jamais compté (leur report ne change rien et n'est l'écriture d'aucun appareil).
 */
export const SEED_AUTHOR = '00000000-0000-4000-8000-000000000000' as DeviceId;

/** Cause du changement d'époque : restauration « Appliquer partout », époques concurrentes, réinitialisation (Y-11). */
export type EpochCarryCause = 'restore' | 'concurrent' | 'reset';
export type EpochCarryMode = 'replace' | 'merge';

/** Compteurs d'un auteur `X` (hlc des écritures reportées) : champs, lignes distinctes, traces purgées ; écritures tardives à part. */
export interface EpochCarryAuthorCount {
  readonly device: DeviceId;
  readonly fields: number;
  readonly rows: number;
  readonly tombs: number;
  /** Lignes reportées par `carryNewer` (écritures locales faites pendant le changement, `epoch-carry-late`) : jamais dans `fields` ni `rows`. */
  readonly late: number;
}

/** Ligne nommée « rétablie » ou « recréée ». `label` : titre ou nom, **local seulement** ; null : repli « (sans titre) » + `shortRowId`. */
export interface EpochCarryNamedItem {
  readonly table: string;
  readonly rowId: string;
  readonly label: string | null;
  /** Auteur de l'écriture qui a rendu la ligne vivante (horloge de `deleted_at`, sinon de la ligne). */
  readonly by: DeviceId;
  /** Rétablie : date physique du hlc de la suppression écartée (ou de la trace) et son auteur ; recréée : null. */
  readonly deletedAt: IsoDateTime | null;
  readonly deletedBy: DeviceId | null;
}

/** Troisième liste : ligne dont le parent a été remplacé (Y-FIX-04), rattachée à « Sans projet » ou mise de côté. */
export interface EpochCarryParentItem extends EpochCarryNoticeItem {
  readonly kind: 'reattached' | 'held';
  readonly cause: 'parent-replaced';
}

/** Contenu d'un compte rendu (compteurs et listes), complété page par page. */
export interface EpochCarryReportBody {
  readonly authors: readonly EpochCarryAuthorCount[];
  readonly restored: readonly EpochCarryNamedItem[];
  readonly recreated: readonly EpochCarryNamedItem[];
  readonly parentReplaced: readonly EpochCarryParentItem[];
  /** Lignes nommées au-delà de `EPOCH_CARRY_REPORT_MAX_NAMED`, toutes listes confondues. */
  readonly overflow: number;
}

export interface EpochCarryReportHead {
  /** Époque cible (ouverte par `opener`). */
  readonly epoch: string;
  readonly cause: EpochCarryCause;
  /** Appareil qui a reporté (celui qui établit le compte rendu). */
  readonly reporter: DeviceId;
  readonly opener: DeviceId;
  readonly mode: EpochCarryMode;
  readonly createdAt: IsoDateTime;
}

export interface EpochCarryReport extends EpochCarryReportHead, EpochCarryReportBody {
  readonly id: number;
  /** Vrai : le compte rendu lève le bandeau tant qu'il n'est pas acquitté (`carryReportBanner`). */
  readonly banner: boolean;
  readonly acknowledgedAt: IsoDateTime | null;
  /** Vrai si une colonne JSON était illisible (lue comme vide, jamais un échec de lecture) : à signaler à l'écran. */
  readonly damaged: boolean;
}

export const EMPTY_CARRY_REPORT_BODY: EpochCarryReportBody = { authors: [], restored: [], recreated: [], parentReplaced: [], overflow: 0 };

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

const tableEntry = (table: string): { readonly label: string | null; readonly kind: string } | undefined =>
  Object.prototype.hasOwnProperty.call(CARRY_REPORT_TABLES, table) ? CARRY_REPORT_TABLES[table as SyncTableName] : undefined;

/** Libellé local d'une ligne (colonne de la correspondance) ; null si la table n'en a pas ou si la valeur est vide : repli. */
export function carryReportLabel(table: string, values: ReadonlyMap<string, unknown>): string | null {
  const column = tableEntry(table)?.label;
  if (!column) return null;
  const value = values.get(column);
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Identifiant abrégé du repli « (sans titre) » : 8 premiers caractères. */
export function shortRowId(rowId: string): string {
  return rowId.slice(0, 8);
}

/** Clé du type d'élément (« Tâche »…) ; table inconnue : `other`. */
export function carryReportKind(table: string): string {
  return tableEntry(table)?.kind ?? 'other';
}

/** Tables du catalogue de synchro absentes de la correspondance (test : toujours vide). */
export function missingCarryReportTables(): string[] {
  return SYNC_TABLES.map((t) => t.name).filter((name) => tableEntry(name) === undefined);
}

/** État d'une ligne avant (juste après l'étape (b)) ou après l'application de son report. */
export type CarryRowState =
  | { readonly kind: 'alive'; readonly hlc: Hlc }
  | { readonly kind: 'deleted'; readonly hlc: Hlc }
  | { readonly kind: 'purged'; readonly hlc: Hlc }
  | { readonly kind: 'absent' };

/**
 * Classement d'une ligne reportée (définitions de l'en-tête). `before.hlc` (supprimée, purgée) : horloge de la suppression écartée ;
 * `after.hlc` (vivante) : horloge de l'écriture qui l'a rendue vivante.
 */
export function classifyCarriedRow(table: string, rowId: string, label: string | null, before: CarryRowState, after: CarryRowState): { readonly list: 'restored' | 'recreated'; readonly item: EpochCarryNamedItem } | null {
  if (after.kind !== 'alive') return null;
  if (before.kind === 'deleted' || before.kind === 'purged') {
    return { list: 'restored', item: { table, rowId, label, by: hlcDevice(after.hlc), deletedAt: hlcIso(before.hlc), deletedBy: hlcDevice(before.hlc) } };
  }
  if (before.kind === 'absent') return { list: 'recreated', item: { table, rowId, label, by: hlcDevice(after.hlc), deletedAt: null, deletedBy: null } };
  return null;
}

/** Ce qu'une opération reportée ajoute aux compteurs : hlc des champs propres, ou trace purgée, ou écriture tardive. */
export interface CarriedOpCount {
  readonly fields: readonly Hlc[];
  readonly tomb?: Hlc;
  readonly late?: boolean;
}

/** Compteurs par auteur complétés d'une opération (auteur de l'amorce ignoré) ; ordre d'apparition des auteurs conservé (puis trié par l'enregistrement). */
export function addCarriedCount(authors: readonly EpochCarryAuthorCount[], op: CarriedOpCount): EpochCarryAuthorCount[] {
  const out = authors.map((a) => ({ ...a }));
  const entry = (device: DeviceId): { device: DeviceId; fields: number; rows: number; tombs: number; late: number } => {
    let found = out.find((a) => a.device === device);
    if (!found) {
      found = { device, fields: 0, rows: 0, tombs: 0, late: 0 };
      out.push(found);
    }
    return found;
  };
  if (op.tomb !== undefined) {
    entry(hlcDevice(op.tomb)).tombs += 1;
    return out;
  }
  const byAuthor = new Map<DeviceId, number>();
  for (const hlc of op.fields) if (hlcDevice(hlc) !== SEED_AUTHOR) byAuthor.set(hlcDevice(hlc), (byAuthor.get(hlcDevice(hlc)) ?? 0) + 1);
  for (const [device, fields] of byAuthor) {
    const e = entry(device);
    if (op.late) e.late += 1;
    else {
      e.fields += fields;
      e.rows += 1;
    }
  }
  return out;
}

/** Nombre total d'écritures reportées (champs, traces, tardives) : zéro, aucun bandeau (critère 8). */
export function carriedWrites(body: Pick<EpochCarryReportBody, 'authors'>): number {
  return body.authors.reduce((sum, a) => sum + a.fields + a.tombs + a.late, 0);
}

/** Lignes nommées (listes et débordement). */
export function namedCount(body: Omit<EpochCarryReportBody, 'authors'>): number {
  return body.restored.length + body.recreated.length + body.parentReplaced.length + body.overflow;
}

/**
 * Bandeau : remplacement seulement (en fusion rien n'est rétabli), au moins une écriture reportée et au moins une ligne nommée
 * (critères 7, 8, 16 et 19 : un compte rendu sans élément nommé est lisible dans Détails, sans bandeau).
 */
export function carryReportBanner(mode: EpochCarryMode, body: EpochCarryReportBody): boolean {
  return mode === 'replace' && carriedWrites(body) > 0 && namedCount(body) > 0;
}

type Ranked = { readonly rank: number; readonly date: string | null; readonly table: string; readonly rowId: string };

/** Ordre déterministe des lignes nommées : rétablies, recréées, parent remplacé ; puis date de suppression écartée décroissante, table, identifiant. */
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.date !== b.date) {
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? 1 : -1;
  }
  if (a.table !== b.table) return a.table < b.table ? -1 : 1;
  return a.rowId < b.rowId ? -1 : a.rowId > b.rowId ? 1 : 0;
}

const namedKey = (item: { readonly table: string; readonly rowId: string }): string => `${item.table}\u0000${item.rowId}`;
const parentKey = (item: { readonly table: string; readonly rowId: string; readonly column: string }): string => `${item.table}\u0000${item.rowId}\u0000${item.column}`;

/**
 * Listes complétées : un même élément n'est jamais ajouté deux fois ; `dropped` (lignes de nouveau supprimées plus loin dans le report)
 * sort des listes « rétablies » et « recréées » ; puis borne : les `EPOCH_CARRY_REPORT_MAX_NAMED` premières lignes dans l'ordre déterministe
 * sont gardées, le reste s'ajoute à `overflow`. Le résultat est le même que si toutes les pages avaient été classées d'un coup.
 */
export function addNamed(
  body: EpochCarryReportBody,
  add: { readonly restored?: readonly EpochCarryNamedItem[]; readonly recreated?: readonly EpochCarryNamedItem[]; readonly parentReplaced?: readonly EpochCarryParentItem[]; readonly dropped?: readonly { readonly table: string; readonly rowId: string }[] },
  max: number = EPOCH_CARRY_REPORT_MAX_NAMED,
): EpochCarryReportBody {
  const dropped = new Set((add.dropped ?? []).map(namedKey));
  const seenNamed = new Set<string>();
  const named = (current: readonly EpochCarryNamedItem[], extra: readonly EpochCarryNamedItem[]): EpochCarryNamedItem[] => {
    const out: EpochCarryNamedItem[] = [];
    for (const item of [...current, ...extra]) {
      const key = namedKey(item);
      if (seenNamed.has(key) || dropped.has(key)) continue;
      seenNamed.add(key);
      out.push(item);
    }
    return out;
  };
  const restored = named(body.restored, add.restored ?? []);
  const recreated = named(body.recreated, add.recreated ?? []);
  const seenParent = new Set<string>();
  const parentReplaced = [...body.parentReplaced, ...(add.parentReplaced ?? [])].filter((item) => {
    const key = parentKey(item);
    if (seenParent.has(key)) return false;
    seenParent.add(key);
    return true;
  });
  const ranked: { readonly r: Ranked; readonly list: 0 | 1 | 2; readonly item: EpochCarryNamedItem | EpochCarryParentItem }[] = [
    ...restored.map((item) => ({ r: { rank: 0, date: item.deletedAt, table: item.table, rowId: item.rowId }, list: 0 as const, item })),
    ...recreated.map((item) => ({ r: { rank: 1, date: null, table: item.table, rowId: item.rowId }, list: 1 as const, item })),
    ...parentReplaced.map((item) => ({ r: { rank: 2, date: null, table: item.table, rowId: `${item.rowId}\u0000${item.column}` }, list: 2 as const, item })),
  ].sort((a, b) => compareRanked(a.r, b.r));
  const kept = ranked.slice(0, max);
  return {
    authors: body.authors,
    restored: kept.filter((k) => k.list === 0).map((k) => k.item as EpochCarryNamedItem),
    recreated: kept.filter((k) => k.list === 1).map((k) => k.item as EpochCarryNamedItem),
    parentReplaced: kept.filter((k) => k.list === 2).map((k) => k.item as EpochCarryParentItem),
    overflow: body.overflow + ranked.length - kept.length,
  };
}

/** Items de la notice de Y-FIX-04 copiés dans la troisième liste (cause `parent-replaced`). */
export function parentItemsOf(reattached: readonly EpochCarryNoticeItem[], held: readonly EpochCarryNoticeItem[]): EpochCarryParentItem[] {
  return [...reattached.map((item) => ({ ...item, kind: 'reattached' as const, cause: 'parent-replaced' as const })), ...held.map((item) => ({ ...item, kind: 'held' as const, cause: 'parent-replaced' as const }))];
}

/**
 * Items d'une notice antérieure (écrite avant tout compte rendu, ou par une version de l'app sans compte rendu) qu'aucun compte rendu
 * existant ne nomme : copiés dans le premier compte rendu suivant (fiche Y-FIX-04, « Reprise par Y-TECH-05 »).
 */
export function noticeItemsNotReported(notice: EpochCarryNotice | null, reports: readonly Pick<EpochCarryReportBody, 'parentReplaced'>[]): EpochCarryParentItem[] {
  if (!notice) return [];
  const known = new Set(reports.flatMap((r) => r.parentReplaced.map(parentKey)));
  return parentItemsOf(notice.reattached, notice.held).filter((item) => !known.has(parentKey(item)));
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

/**
 * Cause d'un changement d'époque : fusion ou réinitialisation (Y-11, même par remplacement depuis une autre époque) : `reset` ; même
 * numéro d'époque que l'époque quittée : `concurrent` ; sinon `restore` (restauration « Appliquer partout »).
 */
export function carryCause(options: { readonly mode: EpochCarryMode; readonly reset: boolean; readonly fromN: number | null; readonly targetN: number }): EpochCarryCause {
  if (options.mode === 'merge' || options.reset) return 'reset';
  return options.fromN !== null && options.fromN === options.targetN ? 'concurrent' : 'restore';
}
