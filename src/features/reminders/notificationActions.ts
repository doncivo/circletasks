import { nowIso } from '../../domain/clock';
import {
  ACTION_TYPE_ID,
  ACTIONS_BY_CATEGORY,
  compareEntries,
  enqueueActions,
  parseActionTarget,
  snoozeFireAt,
  trimApplied,
  upsertSnooze,
  type ActionError,
  type ActionQueueEntry,
  type NotificationActionQueueV1,
} from '../../domain/notificationActions';
import type { ActionsFailureReason } from '../../domain/notificationStatus';
import { isValidTimeZone } from '../../domain/timeZone';
import type { ReminderId, RoutineId, TaskId } from '../../domain/types';
import { t } from '../../i18n';
import { logFailure } from '../../platform/desktop/log';
import type { ActionTypeSpec, NotificationActionSource } from '../../platform/notifications';
import type { AppContainer } from '../app/container';
import { createRoutineUseCases } from '../routines/routineUseCases';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { actionQueueController } from './actionQueue';
import { statusController } from './notificationStatus';

/**
 * Actions « Fait » et « +15 min » des notifications (N-03, ADR 0012 avenant N3) : un étape au début de chaque passage de
 * `replanNotifications`. (1) catégories enregistrées une fois par processus, avant le premier envoi ; (2) état du délégué ;
 * (3) collecte : `drain` du fichier natif, écriture dans la file locale durable, puis `ack` (jamais l'inverse) ; (4) application par les
 * cas d'usage (T-04 pour une tâche, R-03 pour une routine à la date de la notification, jamais de SQL ici) ; « +15 min » ajoute une
 * répétition au plan sans rien écrire dans les données synchronisées. Aucun échec silencieux : une panne est écrite dans
 * `notifications.status` (`actionsFailure`), une action qui n'a pas pu être appliquée reste dans la file avec son code.
 */

// ---------------------------------------------------------------------------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------------------------------------------------------------------------

const ACTION_TITLE_KEY = { done: 'notifications.action.done', snooze15: 'notifications.action.snooze' } as const;

/** Catégories et actions, titres en français depuis `src/i18n` ; toutes au premier plan (l'app s'ouvre). */
export function actionTypeSpecs(): ActionTypeSpec[] {
  return (Object.keys(ACTION_TYPE_ID) as (keyof typeof ACTION_TYPE_ID)[]).map((category) => ({
    id: ACTION_TYPE_ID[category],
    actions: ACTIONS_BY_CATEGORY[category].map((id) => ({ id, title: t(ACTION_TITLE_KEY[id]), foreground: true as const })),
  }));
}

const registered = new WeakMap<AppContainer, Promise<void>>();

/** Enregistre les catégories une fois par processus (avant le premier envoi) ; un échec n'est pas mémorisé : nouvel essai au passage suivant. */
function ensureActionTypes(container: AppContainer, source: NotificationActionSource): Promise<void> {
  let known = registered.get(container);
  if (known === undefined) {
    known = source.registerActionTypes(actionTypeSpecs());
    registered.set(container, known);
    known.catch(() => registered.delete(container));
  }
  return known;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Réveil (événement `action` du plugin)
// ---------------------------------------------------------------------------------------------------------------------------------

interface Wake {
  readonly handler: () => void;
  stop: (() => void) | null;
}

const wakes = new WeakMap<AppContainer, Wake>();

/** Demande un passage `action` quand le plugin écrit une ligne (course entre `didReceive` et le `drain` de la reprise). */
export function setActionWakeHandler(container: AppContainer, handler: () => void): () => void {
  const wake: Wake = { handler, stop: null };
  wakes.set(container, wake);
  return () => {
    wake.stop?.();
    wake.stop = null;
    if (wakes.get(container) === wake) wakes.delete(container);
  };
}

async function ensureWake(container: AppContainer, source: NotificationActionSource): Promise<void> {
  const wake = wakes.get(container);
  if (wake === undefined || wake.stop !== null) return;
  wake.stop = await source.onWake(wake.handler);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Étape du passage
// ---------------------------------------------------------------------------------------------------------------------------------

const FAILURE_PRIORITY: readonly ActionsFailureReason[] = ['queue-write-failed', 'source-failed', 'register-failed', 'delegate-lost'];

/** Ne rejette jamais. Sans source (PC, navigateur) : rien à faire. */
export async function runActionsStep(container: AppContainer): Promise<void> {
  const source = container.notificationActions;
  if (source === null) return;
  const failures = new Set<ActionsFailureReason>();
  try {
    await ensureActionTypes(container, source);
  } catch {
    failures.add('register-failed');
    logFailure('notifications', 'actions register-failed');
  }
  try {
    await ensureWake(container, source);
    if (!(await source.status()).delegate) {
      failures.add('delegate-lost');
      logFailure('notifications', 'actions delegate-lost');
    }
  } catch {
    failures.add('source-failed');
    logFailure('notifications', 'actions source-failed');
  }
  await collectActions(container, source, failures);
  await applyActions(container, failures);

  const reason = FAILURE_PRIORITY.find((candidate) => failures.has(candidate)) ?? null;
  const at = nowIso(container.clock);
  await statusController(container).patch((current) => {
    if (reason === null) return current.actionsFailure === null ? current : { ...current, actionsFailure: null };
    return current.actionsFailure?.reason === reason ? current : { ...current, actionsFailure: { at, reason } };
  });
}

/** Collecte : `drain`, écriture de la file, PUIS `ack`. Si l'écriture échoue, rien n'est acquitté (le fichier natif reste le tampon durable). */
async function collectActions(container: AppContainer, source: NotificationActionSource, failures: Set<ActionsFailureReason>): Promise<void> {
  let drained;
  try {
    drained = await source.drain();
  } catch {
    failures.add('source-failed');
    logFailure('notifications', 'actions drain-failed');
    return;
  }
  const lost = drained.unreadable + drained.writeFailures;
  if (drained.lines === 0 && drained.writeFailures === 0) return;
  const nowMs = container.notificationClock.nowMs();
  try {
    await actionQueueController(container).update((queue) => enqueueActions(queue, drained.entries, lost, nowMs).queue);
  } catch {
    failures.add('queue-write-failed');
    logFailure('notifications', 'actions queue-write-failed');
    return;
  }
  if (lost > 0) logFailure('notifications', `actions lost ${String(lost)}`);
  try {
    await source.ack({ lines: drained.lines, writeFailures: drained.writeFailures });
  } catch {
    // Les lignes seront relues au prochain `drain` et écartées par clé : aucune perte, aucun doublon.
    failures.add('source-failed');
    logFailure('notifications', 'actions ack-failed');
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------------------------------------------------------------

type Outcome = { readonly ok: true; readonly snoozeOf?: string } | { readonly ok: false; readonly error: ActionError };

/** Applique les entrées de la file dans l'ordre ; une entrée appliquée est retirée et sa clé gardée (idempotence), les autres restent. */
async function applyActions(container: AppContainer, failures: Set<ActionsFailureReason>): Promise<void> {
  const controller = actionQueueController(container);
  const queue = await controller.load();
  const clock = container.notificationClock;
  const zoneName = clock.zone();
  const zone = zoneName !== null && isValidTimeZone(zoneName) ? zoneName : null;
  for (const entry of [...queue.entries].sort(compareEntries)) {
    let outcome: Outcome;
    try {
      outcome = await applyOne(container, entry);
    } catch {
      logFailure('notifications', 'action apply-failed');
      outcome = { ok: false, error: 'apply-failed' };
    }
    const nowMs = clock.nowMs();
    try {
      await controller.update((current) => settle(current, entry, outcome, nowMs, zone));
    } catch {
      failures.add('queue-write-failed');
      logFailure('notifications', 'actions queue-write-failed');
      return;
    }
  }
}

function settle(queue: NotificationActionQueueV1, entry: ActionQueueEntry, outcome: Outcome, nowMs: number, zone: string | null): NotificationActionQueueV1 {
  if (!queue.entries.some((candidate) => candidate.key === entry.key)) return queue;
  if (!outcome.ok) {
    return { ...queue, entries: queue.entries.map((candidate) => (candidate.key === entry.key ? { ...candidate, tries: candidate.tries + 1, lastError: outcome.error } : candidate)) };
  }
  return {
    ...queue,
    entries: queue.entries.filter((candidate) => candidate.key !== entry.key),
    applied: trimApplied([...queue.applied, { key: entry.key, at: nowMs }], nowMs),
    snoozes: outcome.snoozeOf === undefined ? queue.snoozes : upsertSnooze(queue.snoozes, outcome.snoozeOf, snoozeFireAt(entry.receivedAt, nowMs, zone)),
  };
}

/** Identifiant stable de l'entrée : celui du fichier, sinon le registre (identifiant numérique du plugin vers identifiant stable). */
async function stableIdOf(container: AppContainer, entry: ActionQueueEntry): Promise<string | null> {
  if (entry.sid !== null && entry.sid !== '') return entry.sid;
  const ledger = await container.notificationLedger.read();
  if (ledger.state !== 'valid') return null;
  return ledger.ledger.entries.find((candidate) => candidate.n === entry.numericId)?.sid ?? null;
}

async function applyOne(container: AppContainer, entry: ActionQueueEntry): Promise<Outcome> {
  const sid = await stableIdOf(container, entry);
  if (sid === null) return { ok: false, error: 'target-not-found' };
  const target = parseActionTarget(sid);
  if (target === null) return { ok: false, error: 'target-not-found' };
  // Récapitulatif et fin de Focus n'ont aucune action ; reçue quand même : succès sans effet.
  if (target.kind === 'none') return { ok: true };

  if (entry.action === 'snooze15') return { ok: true, snoozeOf: sid };

  // « Fait » : événement = jamais proposé ; sinon cas d'usage de la cible.
  if (target.kind === 'event') return { ok: true };
  const { repos } = container.data;
  const reminder = await repos.reminders.getById(target.reminderId as ReminderId);
  if (reminder === null || reminder.targetType !== target.kind) return { ok: false, error: 'target-not-found' };
  if (target.kind === 'task') {
    const task = await repos.tasks.getById(reminder.targetId as unknown as TaskId);
    // Absente, supprimée ou déjà terminée : succès sans effet (idempotence, critère 5).
    if (task === null || task.status === 'done') return { ok: true };
    await createTaskUseCases(container).complete(task.id);
    return { ok: true };
  }
  // Routine : validée pour la date de la notification, pas pour aujourd'hui ; refus du cas d'usage (déjà validée, jour non validable) = sans effet.
  await createRoutineUseCases(container).setDone(reminder.targetId as unknown as RoutineId, target.date, true);
  return { ok: true };
}

/** Purge de la file les répétitions mortes ou passées (cible terminée, supprimée, archivée, validée, rappel retiré, échéance passée). */
export async function purgeDeadSnoozes(container: AppContainer, deadIds: readonly string[]): Promise<void> {
  if (deadIds.length === 0) return;
  const dead = new Set(deadIds);
  try {
    await actionQueueController(container).update((queue) => (queue.snoozes.some((snooze) => dead.has(snooze.id)) ? { ...queue, snoozes: queue.snoozes.filter((snooze) => !dead.has(snooze.id)) } : queue));
  } catch {
    // Écriture impossible : la répétition morte reste en file (elle sera purgée au passage suivant) ; l'échec est visible.
    logFailure('notifications', 'actions queue-write-failed');
    const at = nowIso(container.clock);
    await statusController(container).patch((current) => (current.actionsFailure === null ? { ...current, actionsFailure: { at, reason: 'queue-write-failed' } } : current));
  }
}
