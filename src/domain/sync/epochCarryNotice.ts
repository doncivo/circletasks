/**
 * Y-FIX-04 (bloquant B4, ADR 0011 §28) : sort, au report d'époque, d'une ligne reportée dont un parent est **absent de la base remplacée**
 * (parent lu par l'ouvreur puis remplacé par « Appliquer partout ») ; interface livrée à Y-TECH-05 : notice locale
 * `sync_meta.epochCarryNotice` (jamais publiée), noms d'événements, motif et marque des lignes mises de côté.
 *
 * Module pur : règle tirée du catalogue (`parents`, `nullable`), sans table de cas écrite à la main ; notice bornée et cumulée. Aucune I/O.
 * Importé seulement par un module chargé à la demande (`epochSwitch.ts`) : hors du JavaScript de départ. Les deux
 * noms lus au démarrage sont recopiés (`META.epochCarryNotice`, `CARRY_HELD_MARK` de `apply.ts`) et leur égalité est vérifiée par test.
 */

import type { Hlc } from '../types';
import type { SyncTable } from './syncTables';

/** Clé de `sync_meta` de la notice (locale, jamais publiée). */
export const EPOCH_CARRY_NOTICE_META = 'epochCarryNotice';
/** Événements du journal technique (table, colonne, nombre ; aucun contenu). */
export const EPOCH_CARRY_REATTACHED_EVENT = 'epoch-carry-reattached';
export const EPOCH_CARRY_HELD_EVENT = 'epoch-carry-held';
/** Motif `sync_parked` des lignes mises de côté (existant, rejoué par `retryParked`). */
export const EPOCH_CARRY_HELD_REASON = 'missing-parent';
/**
 * Marque posée dans l'opération mise de côté (`sync_parked.op`, JSON local) : quand elle s'applique enfin, la ligne est republiée entière
 * (la nouvelle époque ne la connaît pas) ; elle compte pour l'avertissement `carry-held` tant qu'elle attend.
 */
export const EPOCH_CARRY_HELD_MARK = 'carry';
/** Items gardés par liste ; le reste est compté dans `overflow`. */
export const EPOCH_CARRY_NOTICE_MAX_ITEMS = 200;

export interface EpochCarryNoticeItem {
  readonly table: string;
  readonly rowId: string;
  readonly column: string;
  readonly parentId: string;
  /** Espace de la ligne (`space_id`), null si la table n'en porte pas. */
  readonly space: string | null;
  /** Titre, nom ou texte de la ligne : **local seulement**, jamais publié ni journalisé. */
  readonly label: string | null;
  readonly hlc: Hlc;
}

export interface EpochCarryNotice {
  readonly v: 1;
  /** Époque du dernier report qui l'a complétée. */
  readonly epoch: string;
  /** Heure (ISO) de ce report. */
  readonly at: string;
  readonly reattached: readonly EpochCarryNoticeItem[];
  readonly held: readonly EpochCarryNoticeItem[];
  readonly overflow: number;
}

/** Notice lue de `sync_meta` : forme contrôlée ; illisible ou d'une autre version : null (l'appelant le journalise). */
export function parseEpochCarryNotice(raw: string | null): EpochCarryNotice | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<EpochCarryNotice> | null;
    if (!value || value.v !== 1 || !Array.isArray(value.reattached) || !Array.isArray(value.held) || typeof value.overflow !== 'number') return null;
    return value as EpochCarryNotice;
  } catch {
    return null;
  }
}

/**
 * Verdict d'un lien parent au report d'époque : `keep` (parent présent : appliqué tel quel) ; `detach` (lien **facultatif**, parent absent :
 * colonne mise à nul, « Sans projet » du même espace, décision (c) étendue) ; `hold` (lien **obligatoire**, parent absent : gardé en
 * `sync_parked`, motif `missing-parent`, appliqué si le parent revient). Null : `column` n'est pas un lien parent de `table` au catalogue.
 */
export type CarryParentVerdict = 'keep' | 'detach' | 'hold';

export function carryParentVerdict(table: SyncTable, column: string, parentPresent: boolean): CarryParentVerdict | null {
  if (!table.parents.some((p) => p.column === column)) return null;
  if (parentPresent) return 'keep';
  return table.columns.find((col) => col.name === column)?.nullable === true ? 'detach' : 'hold';
}

const itemKey = (item: EpochCarryNoticeItem): string => `${item.table}\u0000${item.rowId}\u0000${item.column}`;

/**
 * Notice complétée par un report : les items s'ajoutent (un même item n'est jamais compté deux fois, reprise après arrêt), au plus
 * `EPOCH_CARRY_NOTICE_MAX_ITEMS` par liste, le reste dans `overflow` ; plusieurs reports se cumulent tant que la notice n'est pas acquittée.
 */
export function addToEpochCarryNotice(
  previous: EpochCarryNotice | null,
  add: { readonly epoch: string; readonly at: string; readonly reattached: readonly EpochCarryNoticeItem[]; readonly held: readonly EpochCarryNoticeItem[] },
): EpochCarryNotice {
  let overflow = previous?.overflow ?? 0;
  const merge = (current: readonly EpochCarryNoticeItem[], extra: readonly EpochCarryNoticeItem[]): EpochCarryNoticeItem[] => {
    const out = [...current];
    const seen = new Set(out.map(itemKey));
    for (const item of extra) {
      if (seen.has(itemKey(item))) continue;
      seen.add(itemKey(item));
      if (out.length < EPOCH_CARRY_NOTICE_MAX_ITEMS) out.push(item);
      else overflow += 1;
    }
    return out;
  };
  const reattached = merge(previous?.reattached ?? [], add.reattached);
  const held = merge(previous?.held ?? [], add.held);
  return { v: 1, epoch: add.epoch, at: add.at, reattached, held, overflow };
}

/** Libellé local d'une ligne : titre, nom ou texte (jamais publié). */
export function carryLabel(values: ReadonlyMap<string, unknown>): string | null {
  for (const name of ['title', 'name', 'text']) {
    const value = values.get(name);
    if (typeof value === 'string') return value;
  }
  return null;
}

/** Comptes par (table, colonne) des événements `epoch-carry-reattached` et `epoch-carry-held`, dans l'ordre d'apparition. */
export function countByLink(items: readonly Pick<EpochCarryNoticeItem, 'table' | 'column'>[]): { table: string; column: string; count: number }[] {
  const counts = new Map<string, { table: string; column: string; count: number }>();
  for (const item of items) {
    const key = `${item.table}\u0000${item.column}`;
    const entry = counts.get(key) ?? { table: item.table, column: item.column, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()];
}
