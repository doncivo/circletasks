import type { RecapKind } from './recap';
import type { LocalDate, ReminderId } from './types';

/**
 * Identifiants des notifications du plan (ADR 0012, section 3). Le domaine produit l'identifiant stable (chaîne) ; l'identifiant
 * numérique du plugin (32 bits signé) en est dérivé sans état, pour l'adaptateur réel (N-01).
 */

export const taskNotificationId = (reminderId: ReminderId): string => `task:${reminderId}`;
export const routineNotificationId = (reminderId: ReminderId, occurrence: LocalDate): string => `routine:${reminderId}:${occurrence}`;
export const eventNotificationId = (reminderId: ReminderId, occurrence: LocalDate): string => `event:${reminderId}:${occurrence}`;
export const recapNotificationId = (kind: RecapKind, day: LocalDate): string => `recap:${kind}:${day}`;

/** Plage des notifications du plan ; 1 à 65 535 sont réservés hors plan (1 : fin de session Focus). */
export const NUMERIC_ID_MIN = 65_536;
export const NUMERIC_ID_MAX = 2_147_483_647;
const NUMERIC_ID_SPAN = NUMERIC_ID_MAX - NUMERIC_ID_MIN + 1;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** FNV-1a 32 bits (non signé) des octets UTF-8 du texte. */
export function fnv1a32(text: string): number {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
  }
  return hash;
}

/** Identifiant numérique seul : 65 536 + (FNV-1a mod (2^31 − 65 536)). Toujours dans [65 536 ; 2 147 483 647]. */
export function notificationNumericId(stableId: string): number {
  return NUMERIC_ID_MIN + (fnv1a32(stableId) % NUMERIC_ID_SPAN);
}

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Identifiants numériques d'un plan entier. En cas de collision, les identifiants stables sont parcourus dans l'ordre croissant
 * (unités de code) et le suivant prend la valeur libre suivante de la plage, avec bouclage : jamais d'erreur pour une collision.
 * Un identifiant stable répété compte une fois. Plus de 2^31 − 65 536 identifiants : impossible (le plafond est de 64).
 */
export function assignNumericIds(stableIds: readonly string[], hash: (stableId: string) => number = notificationNumericId): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of [...new Set(stableIds)].sort(byCodeUnits)) {
    let value = hash(id);
    while (taken.has(value)) value = value === NUMERIC_ID_MAX ? NUMERIC_ID_MIN : value + 1;
    taken.add(value);
    out.set(id, value);
  }
  return out;
}
