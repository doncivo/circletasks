import type { Space, Task } from './model';
import { defaultSpaceFor } from './spaceRules';
import type { Id, IsoDateTime, ProjectId, SpaceFilter, SpaceId, TaskId } from './types';

/**
 * Session Focus (M10, PRD section 6 `focus_session`) : `task_id` facultatif, `space_id`, durée prévue (nulle pour « Libre »), début,
 * fin, secondes de pause et pause en cours (`paused_at`, F-02). `focus_session` n'a pas de `project_id` : le projet d'une session est
 * celui de sa tâche (ES-08).
 *
 * RÈGLE D'OR (F-01 critère 5) : tout temps se calcule depuis ces horodatages et l'instant courant fourni par l'appelant ; aucun
 * compteur incrémenté à chaque tick n'existe. Mise en veille, arrière-plan et redémarrage ne peuvent donc pas fausser le minuteur.
 */
export interface FocusSessionRecord {
  readonly id: Id;
  readonly taskId: TaskId | null;
  readonly spaceId: SpaceId;
  /** Durée prévue en minutes ; null : session « Libre » (aucune limite, compte le temps écoulé). */
  readonly plannedMin: number | null;
  readonly startedAt: IsoDateTime;
  /** null tant que la session n'est pas terminée. */
  readonly endedAt: IsoDateTime | null;
  /** Total des pauses closes, en secondes. */
  readonly pausedSec: number;
  /** Début de la pause en cours (F-02), null si la session court. */
  readonly pausedAt: IsoDateTime | null;
}

/** Espace (et projet) porté par une session au lancement. */
export interface FocusPlacement {
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
}

/**
 * Règle d'espace d'une session lancée (ES-08 critère 2) : avec une tâche, l'espace et le projet de la tâche ; sans tâche, l'espace
 * actif au lancement (filtre Pro / Perso ; « Tout » : Pro, comme toute création, T-01) et aucun projet. Null seulement tant que les
 * espaces ne sont pas chargés.
 */
export function focusPlacementAtLaunch(
  task: Pick<Task, 'spaceId' | 'projectId'> | null,
  filter: SpaceFilter,
  spaces: readonly Pick<Space, 'id' | 'sortOrder'>[],
): FocusPlacement | null {
  if (task) return { spaceId: task.spaceId, projectId: task.projectId };
  const spaceId = defaultSpaceFor(filter, spaces);
  return spaceId ? { spaceId, projectId: null } : null;
}

/** Projet d'une session : celui de sa tâche (aucun sans tâche ou si la tâche est inconnue). */
export function projectOfFocusSession(session: Pick<FocusSessionRecord, 'taskId'>, tasks: ReadonlyMap<TaskId, Pick<Task, 'projectId'>>): ProjectId | null {
  return session.taskId ? (tasks.get(session.taskId)?.projectId ?? null) : null;
}

/**
 * Temps de concentration d'une session, en secondes : durée écoulée moins les pauses ; 0 tant qu'elle n'est pas terminée ou si les
 * instants sont illisibles.
 */
export function focusSeconds(session: Pick<FocusSessionRecord, 'startedAt' | 'endedAt' | 'pausedSec'>): number {
  if (session.endedAt === null) return 0;
  const elapsed = (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 1000;
  return Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed - session.pausedSec)) : 0;
}

// --- F-01 : minuteur calculé depuis les horodatages ---------------------------------------------------------------------------

/** Durées proposées (minutes) ; « Libre » est représenté par null. */
export const FOCUS_DURATIONS_MIN = [25, 50, 90] as const;
export type FocusDuration = (typeof FOCUS_DURATIONS_MIN)[number] | null;
export const DEFAULT_FOCUS_DURATION: FocusDuration = 25;
/** Plafond du temps actif d'une session « Libre » (oubli, F-01 D6). */
export const FOCUS_FREE_CAP_MS = 8 * 60 * 60 * 1000;
/** Sous cette durée de temps actif, une session arrêtée est supprimée sans trace (F-01 critère 7). */
export const FOCUS_MIN_KEPT_MS = 60 * 1000;
/** Au retour dans l'app, une session dépassée de plus que ceci est close à son terme prévu, sans son (F-01 critère 9, F-04 critère 5). */
export const FOCUS_OVERDUE_GRACE_MS = 60 * 1000;

const MS_PER_MIN = 60 * 1000;

type Timing = Pick<FocusSessionRecord, 'startedAt' | 'endedAt' | 'pausedSec' | 'pausedAt' | 'plannedMin'>;

/** Valeur lue dans le réglage mémorisé `focus.lastDuration` : durée connue, sinon la durée par défaut ; null reste « Libre ». */
export function sanitizeFocusDuration(value: unknown): FocusDuration {
  if (value === null) return null;
  return FOCUS_DURATIONS_MIN.find((minutes) => minutes === value) ?? DEFAULT_FOCUS_DURATION;
}

/** Durée totale des pauses (ms) à l'instant `endMs` : pauses closes + pause en cours. */
export function pausedMs(session: Pick<FocusSessionRecord, 'pausedSec' | 'pausedAt'>, endMs: number): number {
  const open = session.pausedAt === null ? 0 : Math.max(0, endMs - Date.parse(session.pausedAt));
  return session.pausedSec * 1000 + (Number.isFinite(open) ? open : 0);
}

/**
 * Temps de concentration écoulé (ms) : (fin ou maintenant) - début - pauses. Jamais négatif, même si l'horloge recule. Une session
 * terminée garde sa valeur finale quel que soit `nowMs`.
 */
export function elapsedActiveMs(session: Pick<FocusSessionRecord, 'startedAt' | 'endedAt' | 'pausedSec' | 'pausedAt'>, nowMs: number): number {
  const endMs = session.endedAt === null ? nowMs : Date.parse(session.endedAt);
  const total = endMs - Date.parse(session.startedAt) - pausedMs(session, endMs);
  return Number.isFinite(total) ? Math.max(0, total) : 0;
}

/** Limite de temps actif : durée prévue, ou plafond de 8 h pour « Libre ». */
function activeLimitMs(session: Pick<FocusSessionRecord, 'plannedMin'>): number {
  return session.plannedMin === null ? FOCUS_FREE_CAP_MS : session.plannedMin * MS_PER_MIN;
}

/** Temps actif restant (ms) d'une session à durée prévue ; null pour « Libre ». Peut être ≤ 0 (terme atteint). */
export function remainingMs(session: Timing, nowMs: number): number | null {
  return session.plannedMin === null ? null : session.plannedMin * MS_PER_MIN - elapsedActiveMs(session, nowMs);
}

/** Fraction du temps prévu restant (anneau : 1 = plein) ; « Libre » : toujours 1. */
export function remainingFraction(session: Timing, nowMs: number): number {
  if (session.plannedMin === null) return 1;
  const left = remainingMs(session, nowMs) ?? 0;
  return Math.min(1, Math.max(0, left / (session.plannedMin * MS_PER_MIN)));
}

/** Terme de la session (ms) : temps actif prévu atteint, ou plafond de 8 h pour « Libre ». Les pauses closes décalent le terme. */
export function endAtMs(session: Pick<FocusSessionRecord, 'startedAt' | 'plannedMin' | 'pausedSec'>): number {
  return Date.parse(session.startedAt) + session.pausedSec * 1000 + activeLimitMs(session);
}

/**
 * Instant de la fin NOTIFIÉE (F-04 critères 8 et 9) : début + durée prévue + pauses closes ; null pour « Libre » (aucune fin
 * automatique), pour une session en pause (la fin est annulée, F-02 critère 8) ou déjà terminée.
 */
export function notificationFireAtMs(session: Timing): number | null {
  if (session.plannedMin === null || session.pausedAt !== null || session.endedAt !== null) return null;
  return endAtMs(session);
}

/** Le terme est-il atteint ? Une session déjà terminée ne l'est plus (elle est close). Une session en pause ne dépasse jamais son terme. */
export function isElapsed(session: Timing, nowMs: number): boolean {
  if (session.endedAt !== null) return false;
  return elapsedActiveMs(session, nowMs) >= activeLimitMs(session);
}

/** De combien (ms) le terme est dépassé à `nowMs` (0 s'il n'est pas atteint). */
export function overdueMs(session: Timing, nowMs: number): number {
  return Math.max(0, elapsedActiveMs(session, nowMs) - activeLimitMs(session));
}

/** Instant de clôture d'une session dont le terme est atteint : le terme lui-même, sans temps supplémentaire (F-04 critère 1). */
export function closeAtTerm(session: Pick<FocusSessionRecord, 'startedAt' | 'plannedMin' | 'pausedSec'>): IsoDateTime {
  return new Date(endAtMs(session)).toISOString() as IsoDateTime;
}

/** Une session de moins d'une minute de temps actif n'est pas conservée (F-01 critère 7). */
export function isTooShortToKeep(session: Pick<FocusSessionRecord, 'startedAt' | 'endedAt' | 'pausedSec' | 'pausedAt'>, nowMs: number): boolean {
  return elapsedActiveMs(session, nowMs) < FOCUS_MIN_KEPT_MS;
}

/** Valeurs à écrire pour arrêter la session à `atIso` : la pause en cours est close à cet instant (F-02 critère 5). */
export function stopValues(
  session: Pick<FocusSessionRecord, 'pausedSec' | 'pausedAt'>,
  atIso: IsoDateTime,
): { readonly endedAt: IsoDateTime; readonly pausedSec: number; readonly pausedAt: null } {
  const open = session.pausedAt === null ? 0 : Math.max(0, Math.round((Date.parse(atIso) - Date.parse(session.pausedAt)) / 1000));
  return { endedAt: atIso, pausedSec: session.pausedSec + open, pausedAt: null };
}

/** Texte « MM:SS » (« H:MM:SS » au-delà d'une heure) d'un nombre de secondes. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Temps affiché : restant arrondi à la seconde supérieure (15:34 jusqu'à 15:33.000), écoulé arrondi à l'inférieure (« Libre »). */
export function displayClock(session: Timing, nowMs: number): string {
  const left = remainingMs(session, nowMs);
  return left === null ? formatClock(elapsedActiveMs(session, nowMs) / 1000) : formatClock(Math.ceil(Math.max(0, left) / 1000));
}

/** Minutes entières de temps actif d'une session (libellé « Arrêter et enregistrer N min »). */
export function activeMinutes(session: Pick<FocusSessionRecord, 'startedAt' | 'endedAt' | 'pausedSec' | 'pausedAt'>, nowMs: number): number {
  return Math.floor(elapsedActiveMs(session, nowMs) / MS_PER_MIN);
}

// --- F-02 : pause et reprise ---------------------------------------------------------------------------------------------------

/** Au-delà de cette durée de pause, « Toujours en pause ? » est proposé (pas d'arrêt automatique, F-02 critère 7). */
export const FOCUS_LONG_PAUSE_MS = 2 * 60 * 60 * 1000;

/** La session est en pause (pause ouverte, non terminée). */
export function isPaused(session: Pick<FocusSessionRecord, 'pausedAt' | 'endedAt'>): boolean {
  return session.pausedAt !== null && session.endedAt === null;
}

/** Durée de la pause en cours (ms) ; 0 si la session court. Calculée depuis `paused_at` : elle continue en veille ou app fermée. */
export function currentPauseMs(session: Pick<FocusSessionRecord, 'pausedAt' | 'endedAt'>, nowMs: number): number {
  if (!isPaused(session) || session.pausedAt === null) return 0;
  const since = Date.parse(session.pausedAt);
  return Number.isFinite(since) ? Math.max(0, nowMs - since) : 0;
}

/** Pause de plus de 2 h : proposer de reprendre ou d'arrêter (F-02 critère 7). */
export function isLongPause(session: Pick<FocusSessionRecord, 'pausedAt' | 'endedAt'>, nowMs: number): boolean {
  return currentPauseMs(session, nowMs) > FOCUS_LONG_PAUSE_MS;
}

/** Valeurs à écrire pour mettre en pause à `atIso` (F-02 critère 1). Une seule pause ouverte à la fois : null si déjà en pause. */
export function pauseValues(session: Pick<FocusSessionRecord, 'pausedAt'>, atIso: IsoDateTime): { readonly pausedAt: IsoDateTime } | null {
  return session.pausedAt === null ? { pausedAt: atIso } : null;
}

/**
 * Valeurs à écrire pour reprendre à `atIso` (F-02 critère 2) : la durée de la pause s'ajoute à `paused_sec` (arrondie à la seconde),
 * `paused_at` est vidé. Null si la session n'est pas en pause. Le terme prévu se recalcule (début + durée + pauses) : la pause ne
 * prolonge pas le temps actif restant.
 */
export function resumeValues(
  session: Pick<FocusSessionRecord, 'pausedAt' | 'pausedSec'>,
  atIso: IsoDateTime,
): { readonly pausedAt: null; readonly pausedSec: number } | null {
  if (session.pausedAt === null) return null;
  const seconds = Math.max(0, Math.round((Date.parse(atIso) - Date.parse(session.pausedAt)) / 1000));
  return { pausedAt: null, pausedSec: session.pausedSec + seconds };
}
