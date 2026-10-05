/**
 * Fusion par champ et détection des conflits (ADR 0011, sections 4.1 à 4.3 ; Y-02 critères 2 et 7, Y-05 critère 4, Y-09 critère 1).
 *
 * Règle : pour chaque champ reçu `(v_r, h_r, b_r)` et le champ local `(v_l, h_l, base_l)`, la valeur au plus grand hlc gagne ; un hlc
 * égal ou inférieur ne change rien (idempotence, ordre d'arrivée indifférent). Un **conflit** est inscrit quand deux appareils ont
 * modifié le même champ sans avoir vu la modification de l'autre et avec des valeurs différentes :
 * - distant gagnant (`h_r > h_l`) : conflit si `b_r ≠ h_l` et `v_r ≠ v_l` ;
 * - local gagnant (`h_r < h_l`) : conflit si `base_l ≠ h_r` et `v_r ≠ v_l`.
 * Les deux appareils détectent le même conflit (même valeur gardée, même valeur écartée).
 *
 * `base_l` d'un champ venu d'ailleurs est la base publiée avec lui (`b_r` de l'écrivain) : un troisième appareil qui reçoit en retard
 * une écriture que le gagnant connaissait déjà ne voit pas de conflit.
 *
 * Module pur : aucune I/O ; le moteur (src/sync) lit les champs locaux, applique les décisions et inscrit les conflits.
 */

import type { DeviceId, Hlc } from '../types';
import type { SyncField, SyncValue } from './format';
import { hlcDevice } from './parse';

/** Champ local tel que la fusion le voit : valeur, horloge du champ (section 3.2), base, et « en attente de publication ». */
export interface LocalField {
  readonly value: SyncValue;
  readonly hlc: Hlc;
  readonly base: Hlc | null;
  /** Écriture locale pas encore publiée (entrée de `sync_outbox` pour ce champ ou `'*'`). */
  readonly pending: boolean;
}

export interface ConflictSide {
  readonly value: SyncValue;
  readonly hlc: Hlc;
  readonly device: DeviceId;
}

export interface FieldConflict {
  readonly kept: ConflictSide;
  readonly discarded: ConflictSide;
}

export interface FieldDecision {
  /** Vrai : écrire la valeur distante et prendre son horloge. */
  readonly apply: boolean;
  readonly conflict: FieldConflict | null;
}

export interface MergeOptions {
  /**
   * Valeurs venues d'un instantané (reprise, section 5.5) : leur base est inconnue ; un conflit n'est inscrit que contre une écriture
   * locale encore en attente (sinon chaque valeur plus récente passerait pour un conflit).
   */
  readonly fromSnapshot?: boolean;
}

/** Égalité de deux valeurs publiées (texte, nombre ou null). */
export function sameValue(a: SyncValue, b: SyncValue): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

const side = (value: SyncValue, hlc: Hlc): ConflictSide => ({ value, hlc, device: hlcDevice(hlc) });

/** Décision pour un champ reçu (hlc déjà validés par `parse.ts`). */
export function mergeField(local: LocalField | null, remote: SyncField, options: MergeOptions = {}): FieldDecision {
  const [value, hlc, base] = remote;
  if (local === null) return { apply: true, conflict: null };
  if (hlc === local.hlc) return { apply: false, conflict: null };
  const differs = !sameValue(value, local.value);
  if (hlc > local.hlc) {
    const unseen = options.fromSnapshot ? local.pending : base !== local.hlc;
    return { apply: true, conflict: unseen && differs ? { kept: side(value, hlc), discarded: side(local.value, local.hlc) } : null };
  }
  const unseen = options.fromSnapshot ? local.pending : local.base !== hlc;
  return { apply: false, conflict: unseen && differs ? { kept: side(local.value, local.hlc), discarded: side(value, hlc) } : null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Suppression contre modification (section 4.2, decisions.md « Modification d'un élément supprimé »)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Valeur montrée pour la valeur écartée d'un conflit « supprimé / modifié » (le texte affiché vient de src/i18n, Y-04). */
export const MODIFIED_MARKER = 'modified';

/**
 * Une modification distante d'un élément supprimé ici : la suppression locale reste (règle ordinaire sur `deleted_at`, que l'opération
 * ne touche pas), les autres champs sont fusionnés dans la ligne supprimée, et un conflit est inscrit si l'écrivain n'avait pas vu la
 * suppression (ce qu'atteste le fait que son écriture s'applique : un appareil qui avait lu la suppression n'aurait modifié qu'un
 * élément restauré). Renvoie null s'il n'y a pas de conflit.
 */
export function modifiedWhileDeleted(local: { readonly deletedAt: SyncValue; readonly deletedHlc: Hlc }, appliedFields: readonly SyncField[], touchesDeletedAt: boolean): FieldConflict | null {
  if (local.deletedAt === null || touchesDeletedAt || appliedFields.length === 0) return null;
  const latest = appliedFields.reduce((best, field) => (field[1] > best[1] ? field : best));
  if (hlcDevice(latest[1]) === hlcDevice(local.deletedHlc)) return null;
  return { kept: side(local.deletedAt, local.deletedHlc), discarded: side(MODIFIED_MARKER, latest[1]) };
}

/**
 * Une suppression distante gagnante sur un élément modifié ici : conflit si un champ local (hors `deleted_at`) porte une écriture d'un
 * autre appareil que le suppresseur que celui-ci n'avait pas lue (`knows(device, hlc)` : accusé publié par le suppresseur ; une écriture
 * postérieure à la suppression n'a jamais pu être lue). Approximation documentée : l'accusé peut être plus récent que la suppression.
 */
export function deletedWhileModified(
  deletion: SyncField,
  localFields: ReadonlyMap<string, LocalField>,
  knows: (device: DeviceId, hlc: Hlc) => boolean,
): FieldConflict | null {
  const [deletedAt, deletedHlc] = deletion;
  if (deletedAt === null) return null;
  const deleter = hlcDevice(deletedHlc);
  let latest: LocalField | null = null;
  for (const [name, field] of localFields) {
    if (name === 'deleted_at') continue;
    const writer = hlcDevice(field.hlc);
    if (writer === deleter) continue;
    if (field.hlc < deletedHlc && knows(writer, field.hlc)) continue;
    if (latest === null || field.hlc > latest.hlc) latest = field;
  }
  return latest === null ? null : { kept: side(deletedAt, deletedHlc), discarded: side(MODIFIED_MARKER, latest.hlc) };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Modèle de réplique (référence des propriétés fast-check et du moteur)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Champ d'une réplique : `[valeur, hlc, base]`. */
export type ReplicaField = readonly [SyncValue, Hlc, Hlc | null];
/** Réplique : clé de ligne (`table|id`) → champ → valeur. */
export type Replica = Map<string, Map<string, ReplicaField>>;

export interface ReplicaOp {
  readonly row: string;
  readonly fields: ReadonlyMap<string, SyncField>;
}

/** Applique des opérations à une réplique (fusion par champ) ; renvoie les conflits détectés. */
export function applyToReplica(replica: Replica, ops: readonly ReplicaOp[], options: MergeOptions = {}): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const op of ops) {
    let row = replica.get(op.row);
    for (const [name, field] of op.fields) {
      const current = row?.get(name);
      const decision = mergeField(current ? { value: current[0], hlc: current[1], base: current[2], pending: false } : null, field, options);
      if (decision.conflict) conflicts.push(decision.conflict);
      if (!decision.apply) continue;
      if (!row) {
        row = new Map();
        replica.set(op.row, row);
      }
      row.set(name, [field[0], field[1], field[2]]);
    }
  }
  return conflicts;
}

/** Projection comparable d'une réplique (valeurs et hlc ; la base ne fait pas partie de l'état convergent). */
export function replicaValues(replica: Replica): Record<string, Record<string, readonly [SyncValue, Hlc]>> {
  const out: Record<string, Record<string, readonly [SyncValue, Hlc]>> = {};
  for (const row of [...replica.keys()].sort()) {
    const fields: Record<string, readonly [SyncValue, Hlc]> = {};
    const map = replica.get(row);
    for (const name of [...(map?.keys() ?? [])].sort()) {
      const field = map?.get(name);
      if (field) fields[name] = [field[0], field[1]];
    }
    out[row] = fields;
  }
  return out;
}
