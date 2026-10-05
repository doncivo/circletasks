/**
 * Dérive d'horloge (ADR 0011, section 4.4 ; Y-09 critère 10 ; dette de l'ADR 0005 soldée).
 *
 * Un enregistrement distant dont un hlc dépasse `nowMs() + 1 h` n'est pas appliqué : la lecture de cet appareil s'arrête avant lui
 * (curseur inchangé) et son statut devient `clock-ahead`. La mesure se fait contre l'**horloge physique** injectée, jamais contre le
 * hlc local (qu'une réception a pu pousser). `HlcClock.receive()` n'est appelé qu'après ce contrôle. Module pur.
 */

import type { Hlc } from '../types';
import type { JournalRecord } from './format';
import { HLC_MAX_DRIFT_MS } from './limits';
import { hlcMs } from './parse';

/** Le hlc (strict, déjà validé) est-il trop en avance sur l'horloge physique ? */
export function isTooFarAhead(hlc: Hlc, nowMs: number): boolean {
  return hlcMs(hlc) > nowMs + HLC_MAX_DRIFT_MS;
}

/** Plus grand hlc d'un enregistrement (champs de toutes ses opérations), ou null s'il est vide. */
export function recordMaxHlc(record: JournalRecord): Hlc | null {
  let max: Hlc | null = null;
  for (const op of record.ops) for (const field of op.f.values()) if (max === null || field[1] > max) max = field[1];
  return max;
}

/** L'enregistrement contient-il un hlc trop en avance (bases comprises) ? */
export function recordIsAhead(record: JournalRecord, nowMs: number): boolean {
  for (const op of record.ops) {
    for (const [, hlc, base] of op.f.values()) {
      if (isTooFarAhead(hlc, nowMs) || (base !== null && isTooFarAhead(base, nowMs))) return true;
    }
  }
  return false;
}
