/**
 * Compatibilité des versions entre appareils (ADR 0011, section 7.2 ; Y-07 critères 1, 3, 8 à 11).
 *
 * Deux numéros circulent avec chaque fichier et chaque état publié :
 * - `sm` : version **majeure** du format de synchro (`SYNC_FORMAT_MAJOR`), augmentée seulement quand une migration retire, renomme ou
 *   change le sens d'une colonne publiée ; un appareil ne lit pas une majeure supérieure à la sienne (lecture suspendue) ;
 * - `sv` : `schema_version`, numéro de la dernière migration de l'écrivain ; une version plus récente de même majeure se lit, ses champs
 *   inconnus sont gardés à part (`sync_unknown`), jamais effacés.
 *
 * Module pur : classement d'un appareil distant par rapport au local et règles qui en découlent. Aucune I/O.
 */

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

/** Raccourci de `keepsUnknownFields` pour deux `sv` de même majeure (règle appliquée par `apply.ts`). */
export function acceptsUnknownFrom(localSv: number, remoteSv: number, sm = 1): boolean {
  return keepsUnknownFields(compareVersions({ sm, sv: localSv }, { sm, sv: remoteSv }));
}

/** Plus récent que l'appareil local : `'schema'` (même majeure), `'major'` (lecture suspendue), sinon null. */
export type NewerKind = 'schema' | 'major' | null;

export function newerKind(relation: VersionRelation): NewerKind {
  return relation === 'newer-major' ? 'major' : relation === 'newer-schema' ? 'schema' : null;
}

/** Statuts d'appareil qui ne comptent plus pour « Mettez à jour l'app » (absent, oublié, autre clé). */
const INACTIVE = new Set(['expired', 'forgotten', 'foreign']);

/**
 * Appareils (autres que soi, actifs) qui publient une version plus récente : ils déclenchent le bandeau « Mettez à jour l'app » (Y-07
 * critère 9) et sont nommés par l'écran de version (critère 10). Un appareil plus ancien n'y figure jamais.
 */
export function newerDevices<D extends { readonly self: boolean; readonly status: string; readonly newer?: NewerKind | undefined }>(devices: readonly D[]): D[] {
  return devices.filter((d) => !d.self && !INACTIVE.has(d.status) && (d.newer === 'schema' || d.newer === 'major'));
}
