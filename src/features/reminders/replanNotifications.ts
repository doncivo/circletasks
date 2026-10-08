import { nowIso } from '../../domain/clock';
import { addDays } from '../../domain/localDate';
import { localDateTimeAt } from '../../domain/notificationInstant';
import { NOTIFICATION_HORIZON_DAYS, NOTIFICATION_LIMIT_DEFAULT, planNotifications, type PlanCoverage } from '../../domain/notificationPlan';
import type { NotificationStatusV1, PlanFailureReason, StatusReport } from '../../domain/notificationStatus';
import { mondayOf } from '../../domain/routineSchedule';
import { isValidTimeZone } from '../../domain/timeZone';
import type { LocalDate, TaskId } from '../../domain/types';
import { logFailure } from '../../platform/desktop/log';
import { NotificationSchedulerError } from '../../platform/notifications';
import type { AppContainer } from '../app/container';
import { actionQueueController } from './actionQueue';
import { purgeDeadSnoozes, runActionsStep } from './notificationActions';
import { requestsFor } from './notificationTexts';
import { failureOf, statusController } from './notificationStatus';

/**
 * Cas d'usage `replanNotifications` (N-01, ADR 0012 avenant N1.3) : UN passage de replanification du plan de notifications de
 * l'iPhone. Lit les données par les repositories, calcule le plan (`planNotifications`, pur), compose les textes (src/i18n) et le
 * remet au planificateur (`replace`, par différence : deux passages identiques rendent `{ 0, 0, n }`).
 *
 * Aucun échec silencieux : autorisation refusée ou non décidée, échec de `replace`, registre illisible, fuseau inconnu sont écrits dans
 * l'état persistant (`notifications.status`) et montrés par le bandeau et Réglages > Rappels ; le premier `replace` réussi les efface.
 * Une exception inattendue est rattrapée et enregistrée `schedule-failed`. Sur le PC : aucune lecture de données ni appel de
 * planification (« Les rappels sont envoyés par l'iPhone »).
 */

export type ReplanTrigger = 'open' | 'resume' | 'sync' | 'hide' | 'edit' | 'action' | 'zone' | 'permission';

export type ReplanOutcome =
  | { readonly status: 'pc' }
  | { readonly status: 'blocked'; readonly permission: 'denied' | 'undetermined' }
  | { readonly status: 'planned'; readonly report: StatusReport; readonly coverage: PlanCoverage; readonly total: number }
  | { readonly status: 'failed'; readonly reason: PlanFailureReason };

/** Marge de recherche des événements au-delà de l'horizon : la plus grande avance (une semaine) plus un jour. */
const EVENT_SEARCH_DAYS = NOTIFICATION_HORIZON_DAYS + 8;

export async function replanNotifications(container: AppContainer, trigger: ReplanTrigger): Promise<ReplanOutcome> {
  const status = statusController(container);
  try {
    await status.load();
    // N-03 : les actions déjà reçues (« Fait », « +15 min ») sont appliquées AVANT tout contrôle d'autorisation ou de disponibilité.
    await runActionsStep(container);
    return await pass(container, trigger, status);
  } catch (error) {
    // Jamais d'avalement : l'exception inattendue devient un échec visible.
    return recordFailure(container, trigger, error);
  }
}

async function recordFailure(
  container: AppContainer,
  trigger: ReplanTrigger,
  error: unknown,
  extra: (current: NotificationStatusV1) => NotificationStatusV1 = (current) => current,
): Promise<ReplanOutcome> {
  const { reason, count, partial } = failureOf(error);
  logFailure('notifications', `replan ${trigger}: ${reason} (${String(count)})`);
  const at = nowIso(container.clock);
  await statusController(container).patch((current) => extra({ ...current, planFailure: { at, reason, count, partial } }));
  return { status: 'failed', reason };
}

async function pass(container: AppContainer, trigger: ReplanTrigger, status: ReturnType<typeof statusController>): Promise<ReplanOutcome> {
  const { notifications: scheduler, notificationClock: clock } = container;
  const at = nowIso(container.clock);

  // (2) Disponibilité : sur le PC, rien n'est lu ni planifié.
  const availability = await scheduler.availability();
  status.setAvailability(availability);
  if (availability === 'unavailable') {
    if (container.platform.runtime === 'tauri' && container.platform.os === 'ios') return recordFailure(container, trigger, new NotificationSchedulerError('unavailable'));
    return { status: 'pc' };
  }

  // (3) Autorisation relue à chaque passage : retirée ou rétablie dans Réglages iOS, le bandeau suit.
  const permission = await scheduler.permission();
  await status.patch((current) => ({ ...current, permission }));
  if (permission !== 'granted') return { status: 'blocked', permission };

  // Fuseau et registre : le changement de fuseau et le registre reconstruit sont des informations visibles (N-06, avenant N1.2).
  const zoneName = clock.zone();
  const zone = zoneName !== null && isValidTimeZone(zoneName) ? zoneName : null;
  const ledger = await container.notificationLedger.read();
  const ledgerZone = ledger.state === 'valid' ? ledger.ledger.zone : null;
  const zoneChange = zone !== null && ledgerZone !== null && ledgerZone !== zone ? { from: ledgerZone, to: zone } : null;
  const ledgerRebuiltAt = ledger.state === 'unreadable' ? at : null;
  if (ledger.state === 'unreadable') logFailure('notifications', 'ledger-unreadable');

  try {
    // (4) Données : repositories seulement.
    const nowMs = clock.nowMs();
    const now = localDateTimeAt(nowMs, zone);
    const today = now.slice(0, 10) as LocalDate;
    const { repos } = container.data;
    const [reminders, routines, pauses, spaces, morning, evening] = await Promise.all([
      repos.reminders.listLive(),
      repos.routines.listForFilter('all'),
      repos.routines.listPauses('all'),
      repos.spaces.listAll(),
      repos.settings.get('reminders.morningRecap'),
      repos.settings.get('reminders.eveningRecap'),
    ]);
    const taskTargets = [...new Set(reminders.filter((reminder) => reminder.targetType === 'task').map((reminder) => reminder.targetId as unknown as TaskId))];
    const weekStart = mondayOf(today);
    // Les validations de la veille comptent aussi : une répétition « +15 min » peut sonner après minuit pour l'occurrence d'hier.
    const yesterday = addDays(today, -1);
    const logsFrom = weekStart < yesterday ? weekStart : yesterday;
    const queue = await actionQueueController(container).load();
    const [targetTasks, todayTasks, logs, events] = await Promise.all([
      repos.tasks.listByIds(taskTargets),
      repos.tasks.listForDay(today, 'all'),
      repos.routineLogs.listForRange({ from: logsFrom, to: addDays(today, EVENT_SEARCH_DAYS) }, 'all'),
      repos.events.listCandidatesForRange({ from: yesterday, to: addDays(today, EVENT_SEARCH_DAYS) }, 'all'),
    ]);
    const tasks = [...new Map([...targetTasks, ...todayTasks].map((task) => [task.id, task])).values()];

    // (5) Place disponible : 64 moins les notifications réservées en attente (fin de Focus).
    const limit = Math.max(0, NOTIFICATION_LIMIT_DEFAULT - (await scheduler.reservedCount()));

    // (6) et (7) Plan et textes.
    const plan = planNotifications({ now, limit, tasks, routines, routinePauses: pauses, routineLogs: logs, events, reminders, spaces, recaps: { morning, evening }, snoozes: queue.snoozes });
    const requests = requestsFor(plan, {
      tasks: new Map(tasks.map((task) => [task.id, task])),
      routines: new Map(routines.map((routine) => [routine.id, routine])),
      events: new Map(events.map((event) => [event.id, event])),
    });

    // N-03 : les répétitions mortes ou passées sont retirées de la file (une répétition vivante coupée par le plafond reste).
    await purgeDeadSnoozes(container, plan.deadSnoozeIds);

    // (8) et (9) Remplacement par différence ; la réussite efface l'échec.
    const report = await scheduler.replace(requests);
    await status.patch((current) => ({
      ...current,
      permission: 'granted',
      lastSuccess: { at, coverage: plan.coverage, total: plan.total, zone },
      // Fuseau illisible : le passage est mené à bout avec le décalage courant, puis l'état reste visible (N-06 critère 3).
      planFailure: zone === null ? { at, reason: 'zone-unknown', count: 0, partial: null } : null,
      zoneChange: zoneChange === null ? null : { at: current.zoneChange?.to === zoneChange.to && current.zoneChange.from === zoneChange.from ? current.zoneChange.at : at, ...zoneChange },
      ledgerRebuiltAt,
    }));
    return { status: 'planned', report, coverage: plan.coverage, total: plan.total };
  } catch (error) {
    return recordFailure(container, trigger, error, (current) => ({
      ...current,
      zoneChange: zoneChange === null ? null : { at: current.zoneChange?.to === zoneChange.to && current.zoneChange.from === zoneChange.from ? current.zoneChange.at : at, ...zoneChange },
      ledgerRebuiltAt,
    }));
  }
}
