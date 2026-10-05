/**
 * Réparations après l'application d'un lot reçu (ADR 0011, section 8 ; Y-02 critère 8). Valeurs **déterministes** : deux appareils qui
 * réparent en même temps écrivent la même valeur, sans conflit.
 *
 * - `routine.paused` est une colonne dérivée, jamais publiée : elle vaut « il existe une période de pause ouverte et non supprimée »
 *   (seule `routine_pause` est fusionnée, avenant R-05).
 * - Une seule session Focus active : si plusieurs sessions non supprimées sont ouvertes, toutes sauf la plus récente (`started_at`,
 *   puis hlc) sont closes à l'heure de début de la plus récente, par une écriture locale (publiée).
 *
 * Module pur.
 */

import type { Hlc, IsoDateTime } from '../types';

export interface PausePeriod {
  readonly toDate: string | null;
  readonly deletedAt: string | null;
}

/** Valeur de `routine.paused` d'après ses périodes de pause. */
export function routinePausedFrom(pauses: readonly PausePeriod[]): boolean {
  return pauses.some((pause) => pause.deletedAt === null && pause.toDate === null);
}

export interface OpenFocusSession {
  readonly id: string;
  readonly startedAt: IsoDateTime;
  readonly hlc: Hlc;
}

/** Sessions à clore (identifiant, `ended_at`) pour qu'il n'en reste qu'une ouverte. */
export function focusSessionsToClose(open: readonly OpenFocusSession[]): readonly { readonly id: string; readonly endedAt: IsoDateTime }[] {
  if (open.length < 2) return [];
  const sorted = [...open].sort((a, b) => (a.startedAt !== b.startedAt ? (a.startedAt < b.startedAt ? 1 : -1) : a.hlc < b.hlc ? 1 : a.hlc > b.hlc ? -1 : 0));
  const [latest, ...older] = sorted;
  if (!latest) return [];
  return older.map((session) => ({ id: session.id, endedAt: latest.startedAt }));
}
