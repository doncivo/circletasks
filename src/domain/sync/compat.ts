/**
 * Compatibilité des versions entre appareils (ADR 0011, section 7.2 ; Y-07 critères 1, 3, 8 à 11).
 *
 * Deux numéros circulent avec chaque fichier et chaque état publié :
 * - `sm` : version **majeure** du format de synchro (`SYNC_FORMAT_MAJOR`), augmentée seulement quand une migration retire, renomme ou
 *   change le sens d'une colonne publiée ; un appareil ne lit pas une majeure supérieure à la sienne (lecture suspendue) ;
 * - `sv` : `schema_version`, numéro de la dernière migration de l'écrivain ; une version plus récente de même majeure se lit, ses champs
 *   inconnus sont gardés à part (`sync_unknown`), jamais effacés.
 *
 * Module pur : classement d'un appareil distant par rapport au local, règles qui en découlent, et décision de réintégration des champs
 * gardés devenus connus (le repository lit et écrit, la règle est ici). Aucune I/O.
 */

import type { DeviceId, Hlc, IsoDateTime } from '../types';
import { SYNC_FORMAT_MAJOR, isStrictHlc, type SyncValue } from './format';
import { mergeField, type FieldConflict, type LocalField } from './merge';
import { hlcDevice, hlcIso } from './parse';
import { TECHNICAL_COLUMNS, isValidValue, type SyncColumn, type SyncTable } from './syncTables';

/** Version d'un appareil telle qu'elle est publiée ; un numéro absent, nul, négatif ou non entier rend le classement invalide. */
export interface SyncVersion {
  readonly sm: number | null | undefined;
  readonly sv: number | null | undefined;
}

/**
 * - `older` : majeure inférieure, ou même majeure et `sv` inférieur (lu normalement) ;
 * - `same` : même majeure, même `sv` ;
 * - `newer-schema` : même majeure, `sv` supérieur (lu ; champs inconnus gardés) ;
 * - `newer-major` : majeure supérieure (lecture suspendue) ;
 * - `invalid` : numéro absent ou à 0 (refus).
 */
export type VersionRelation = 'older' | 'same' | 'newer-schema' | 'newer-major' | 'invalid';

const isVersionNumber = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1;

/** Classe la version `remote` par rapport à `local` (la version locale est supposée valide ; sinon `invalid`). */
export function compareVersions(local: SyncVersion, remote: SyncVersion): VersionRelation {
  if (!isVersionNumber(local.sm) || !isVersionNumber(local.sv) || !isVersionNumber(remote.sm) || !isVersionNumber(remote.sv)) return 'invalid';
  if (remote.sm > local.sm) return 'newer-major';
  if (remote.sm < local.sm) return 'older';
  if (remote.sv > local.sv) return 'newer-schema';
  return remote.sv < local.sv ? 'older' : 'same';
}

/** Un appareil de cette relation peut-il être lu (journaux, instantanés) ? Toujours, sauf une majeure supérieure ou une version invalide. */
export function canRead(relation: VersionRelation): boolean {
  return relation === 'older' || relation === 'same' || relation === 'newer-schema';
}

/**
 * Un champ, une table ou une clé de réglage inconnus reçus de cette version peuvent-ils être gardés (`sync_unknown`) ? Seulement d'une
 * version de schéma strictement plus récente : une version égale ou plus ancienne ne peut pas connaître ce que la version locale ignore
 * (decisions.md, « Champ inconnu reçu d'une version égale ou plus ancienne »).
 */
export function keepsUnknownFields(relation: VersionRelation): boolean {
  return relation === 'newer-schema';
}

/** Raccourci de `keepsUnknownFields` pour deux `sv` de la majeure courante (règle appliquée par `apply.ts`). */
export function acceptsUnknownFrom(localSv: number, remoteSv: number): boolean {
  return keepsUnknownFields(compareVersions({ sm: SYNC_FORMAT_MAJOR, sv: localSv }, { sm: SYNC_FORMAT_MAJOR, sv: remoteSv }));
}

/** Plus récent que l'appareil local : `'schema'` (même majeure), `'major'` (lecture suspendue), sinon null. */
export type NewerKind = 'schema' | 'major' | null;

export function newerKind(relation: VersionRelation): NewerKind {
  return relation === 'newer-major' ? 'major' : relation === 'newer-schema' ? 'schema' : null;
}

/** Statut d'un appareil dans `sync_state` (même union que `DeviceSyncStatus` de la plateforme, vérifiée par test). */
export type DeviceState = 'active' | 'expired' | 'newer-major' | 'clock-ahead' | 'corrupt' | 'foreign' | 'rollback' | 'forgotten';

/**
 * Statuts qui ne comptent pas pour « Mettez à jour l'app » : absent, oublié, autre clé et, décision de revue, état non fiable (`corrupt`,
 * `rollback`) ; `clock-ahead` compte (sa version publiée est authentifiée).
 */
const INACTIVE: ReadonlySet<DeviceState> = new Set<DeviceState>(['expired', 'forgotten', 'foreign', 'corrupt', 'rollback']);

/**
 * Appareils (autres que soi, actifs) qui publient une version plus récente : ils déclenchent le bandeau « Mettez à jour l'app » (Y-07
 * critère 9) et sont nommés par l'écran de version (critère 10). Un appareil plus ancien n'y figure jamais.
 */
export function newerDevices<D extends { readonly self: boolean; readonly status: DeviceState; readonly newer?: NewerKind | undefined }>(devices: readonly D[]): D[] {
  return devices.filter((d) => !d.self && !INACTIVE.has(d.status) && (d.newer === 'schema' || d.newer === 'major'));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Réintégration des champs gardés devenus connus (Y-07 critère 6 ; ADR 0011 §3.2, §5.4, §7.2 ; D3)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Champ gardé dans `sync_unknown`, devenu connu et valide (nom = colonne du catalogue). */
export interface KeptField {
  readonly name: string;
  readonly value: SyncValue;
  readonly hlc: Hlc;
  readonly base: Hlc | null;
  readonly conflictVisible: boolean;
}

/** Champ gardé tel que `sync_unknown` le rend (texte JSON de la valeur, hlc pas encore validés). */
export interface StoredUnknown {
  readonly field: string;
  readonly value: string | null;
  readonly hlc: string;
  readonly base_hlc: string | null;
}

function storedValue(text: string | null): SyncValue | undefined {
  if (typeof text !== 'string') return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Champs gardés d'une ligne de `t` réintégrables : colonne du catalogue (`column`), ni technique, ni locale, ni de clé ; valeur lisible
 * et du type déclaré ; hlc et base stricts. Les autres restent dans `sync_unknown`.
 */
export function keptFieldsOf(t: SyncTable, column: (name: string) => SyncColumn | undefined, stored: readonly StoredUnknown[]): KeptField[] {
  const out: KeptField[] = [];
  for (const s of stored) {
    const col = column(s.field);
    if (!col || col.name === t.key || col.name === 'id' || (TECHNICAL_COLUMNS as readonly string[]).includes(col.name) || t.local.includes(col.name)) continue;
    const value = storedValue(s.value);
    if (value === undefined || !isValidValue(col, value) || !isStrictHlc(s.hlc) || !(s.base_hlc === null || isStrictHlc(s.base_hlc))) continue;
    out.push({ name: col.name, value, hlc: s.hlc, base: s.base_hlc as Hlc | null, conflictVisible: col.conflictVisible });
  }
  return out;
}

export interface ClockState {
  readonly hlc: Hlc;
  readonly base: Hlc | null;
}

/** Ligne locale : hlc, valeurs des colonnes des champs gardés, horloges de champ (`'*'` compris), champs en attente de publication. */
export interface ReintegrationRow {
  readonly hlc: Hlc;
  readonly values: ReadonlyMap<string, SyncValue>;
  readonly clocks: ReadonlyMap<string, ClockState>;
  readonly pending: ReadonlySet<string>;
}

export interface ReintegrationInput {
  readonly fields: readonly KeptField[];
  /** Colonnes publiées de la table (catalogue) : une ligne absente n'est insérée que complète. */
  readonly columns: readonly string[];
  /** Champs de clé étrangère dont la ligne parente est absente ici. */
  readonly missingParents: ReadonlySet<string>;
  /** Ligne locale, ou null si elle n'existe pas (encore). */
  readonly row: ReintegrationRow | null;
  /** Hlc de la trace de purge de cette ligne, s'il y en a une (ligne absente seulement). */
  readonly tombstone: Hlc | null;
}

export interface ReintegrationDecision {
  readonly write: 'none' | 'insert' | 'update';
  /** Colonnes à écrire (insertion : toutes ; mise à jour : les gagnantes). */
  readonly values: ReadonlyMap<string, SyncValue>;
  /** Horloges de champ à écrire (`'*'` d'abord s'il le faut). */
  readonly clocks: readonly { readonly field: string; readonly hlc: Hlc; readonly base: Hlc | null }[];
  /** Métadonnées de ligne : à l'insertion, ou si le plus grand hlc écrit dépasse celui de la ligne. */
  readonly meta: { readonly hlc: Hlc; readonly updatedAt: IsoDateTime; readonly deviceId: DeviceId } | null;
  /** Écritures locales en attente écrasées : retirées de `sync_outbox`. */
  readonly dropPending: readonly string[];
  readonly conflicts: readonly { readonly field: string; readonly conflict: FieldConflict }[];
  /** Champs à retirer de `sync_unknown` (écrits ou dépassés) ; les autres restent. */
  readonly remove: readonly string[];
  readonly reintegrated: number;
  readonly superseded: number;
}

const maxHlc = (hlcs: readonly Hlc[]): Hlc => hlcs.reduce((a, b) => (b > a ? b : a));
const metaOf = (hlc: Hlc): NonNullable<ReintegrationDecision['meta']> => ({ hlc, updatedAt: hlcIso(hlc), deviceId: hlcDevice(hlc) });
const nothing = (remove: readonly string[] = []): ReintegrationDecision => ({ write: 'none', values: new Map(), clocks: [], meta: null, dropPending: [], conflicts: [], remove, reintegrated: 0, superseded: remove.length });

/**
 * Décision pour les champs gardés d'une ligne :
 * - ligne présente : horloge locale du champ = horloge propre, sinon repli `'*'`, sinon hlc de la ligne ; fusion ordinaire (`mergeField`),
 *   sauf la **même écriture** : sans horloge propre et au hlc de ce repli, la valeur gardée vient de l'écriture que la ligne a reçue quand
 *   la colonne n'existait pas ici (la valeur locale n'est que le défaut de la migration) : elle est écrite. Un gagnant dont le parent
 *   manque attend ; les autres champs (écrits ou dépassés) quittent `sync_unknown` ;
 * - ligne absente et purgée : les valeurs au hlc inférieur ou égal à la trace sont retirées, rien n'est recréé (section 5.4) ;
 * - ligne absente : insérée seulement complète et avec ses parents ; sinon tout attend.
 */
export function decideReintegration(input: ReintegrationInput): ReintegrationDecision {
  const { fields, row } = input;
  if (fields.length === 0) return nothing();
  if (row === null) {
    const tomb = input.tombstone;
    if (tomb !== null) return nothing(fields.filter((f) => f.hlc <= tomb).map((f) => f.name));
    const names = new Set(fields.map((f) => f.name));
    if (!input.columns.every((c) => names.has(c)) || fields.some((f) => input.missingParents.has(f.name))) return nothing();
    const rowHlc = maxHlc(fields.map((f) => f.hlc));
    return {
      write: 'insert',
      values: new Map(fields.map((f) => [f.name, f.value])),
      clocks: [{ field: '*', hlc: rowHlc, base: null }, ...fields.filter((f) => f.hlc !== rowHlc || f.base !== null).map((f) => ({ field: f.name, hlc: f.hlc, base: f.base }))],
      meta: metaOf(rowHlc),
      dropPending: [],
      conflicts: [],
      remove: fields.map((f) => f.name),
      reintegrated: fields.length,
      superseded: 0,
    };
  }

  const applied: KeptField[] = [];
  const waiting = new Set<string>();
  const conflicts: { field: string; conflict: FieldConflict }[] = [];
  for (const f of fields) {
    const own = row.clocks.get(f.name);
    const clock = own ?? row.clocks.get('*') ?? { hlc: row.hlc, base: null };
    const local: LocalField = { value: row.values.get(f.name) ?? null, hlc: clock.hlc, base: clock.base, pending: row.pending.has(f.name) || row.pending.has('*') };
    const sameWrite = own === undefined && f.hlc === clock.hlc;
    const decision = sameWrite ? { apply: true, conflict: null } : mergeField(local, [f.value, f.hlc, f.base]);
    if (decision.apply && input.missingParents.has(f.name)) {
      waiting.add(f.name);
      continue;
    }
    if (decision.apply) applied.push(f);
    if (decision.conflict && f.conflictVisible) conflicts.push({ field: f.name, conflict: decision.conflict });
  }
  const remove = fields.filter((f) => !waiting.has(f.name)).map((f) => f.name);
  if (applied.length === 0) return { ...nothing(remove), conflicts };
  const appliedMax = maxHlc(applied.map((f) => f.hlc));
  return {
    write: 'update',
    values: new Map(applied.map((f) => [f.name, f.value])),
    // Repli « * » figé avant que le hlc de la ligne ne bouge (les champs sans horloge propre gardent l'ancien hlc).
    clocks: [...(row.clocks.has('*') ? [] : [{ field: '*', hlc: row.hlc, base: null }]), ...applied.map((f) => ({ field: f.name, hlc: f.hlc, base: f.base }))],
    meta: appliedMax > row.hlc ? metaOf(appliedMax) : null,
    dropPending: applied.filter((f) => row.pending.has(f.name)).map((f) => f.name),
    conflicts,
    remove,
    reintegrated: applied.length,
    superseded: remove.length - applied.length,
  };
}
