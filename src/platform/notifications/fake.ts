import {
  type NotificationAvailability,
  type NotificationPermission,
  type NotificationRequest,
  type NotificationScheduler,
  NotificationSchedulerError,
  type ReplaceReport,
} from './types';
import { sortRequests, validateRequests } from './validate';

/** Appel enregistré par le faux. */
export type FakeNotificationCall =
  | { readonly type: 'replace'; readonly requests: readonly NotificationRequest[] }
  | { readonly type: 'cancelAll' }
  | { readonly type: 'requestPermission' };

/**
 * Faux testé (N-TECH-01 critères 2 à 4) : sémantique complète de `replace` (validation, différence, idempotence), appels enregistrés,
 * états et échecs injectables pour les tests de N-01 (autorisation refusée, plafond, échec de planification).
 */
export interface FakeNotificationScheduler extends NotificationScheduler {
  readonly calls: FakeNotificationCall[];
  setAvailability(value: NotificationAvailability): void;
  setPermission(value: NotificationPermission): void;
  /** Réponse de `requestPermission()` quand l'autorisation n'est pas encore décidée (par défaut `granted`). */
  setPermissionAnswer(value: NotificationPermission): void;
  /** Notifications en attente hors plan (fin de Focus) : comptées dans les 64. */
  setOutsidePlan(count: number): void;
  /** La prochaine `replace` échoue après validation avec cette erreur, sans rien modifier. Consommée par l'appel. */
  failNextReplace(error: NotificationSchedulerError): void;
}

const same = (a: NotificationRequest, b: NotificationRequest): boolean =>
  a.fireAt === b.fireAt && a.title === b.title && a.body === b.body && a.kind === b.kind;

export function createFakeNotificationScheduler(): FakeNotificationScheduler {
  const calls: FakeNotificationCall[] = [];
  const plan = new Map<string, NotificationRequest>();
  let availability: NotificationAvailability = 'available';
  let permission: NotificationPermission = 'granted';
  let answer: NotificationPermission = 'granted';
  let outsidePlan = 0;
  let failure: NotificationSchedulerError | null = null;

  return {
    calls,
    setAvailability: (value) => {
      availability = value;
    },
    setPermission: (value) => {
      permission = value;
    },
    setPermissionAnswer: (value) => {
      answer = value;
    },
    setOutsidePlan: (count) => {
      outsidePlan = count;
    },
    failNextReplace: (error) => {
      failure = error;
    },
    availability: () => Promise.resolve(availability),
    permission: () => Promise.resolve(permission),
    requestPermission: () => {
      calls.push({ type: 'requestPermission' });
      if (permission === 'undetermined') permission = answer;
      return Promise.resolve(permission);
    },
    replace: (requests) => {
      calls.push({ type: 'replace', requests: [...requests] });
      try {
        validateRequests(requests, outsidePlan);
        // Comme l'adaptateur réel : l'état du système est vérifié après la liste, avant tout effet.
        if (availability === 'unavailable') throw new NotificationSchedulerError('unavailable');
        if (permission !== 'granted') throw new NotificationSchedulerError('permission-denied');
        if (failure !== null) {
          const error = failure;
          failure = null;
          throw error;
        }
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      const next = new Map(requests.map((request) => [request.id, request]));
      let scheduled = 0;
      let kept = 0;
      for (const [id, request] of next) {
        const known = plan.get(id);
        if (known === undefined || !same(known, request)) scheduled += 1;
        else kept += 1;
      }
      const cancelled = [...plan.keys()].filter((id) => !next.has(id)).length;
      plan.clear();
      for (const [id, request] of next) plan.set(id, request);
      const report: ReplaceReport = { scheduled, cancelled, kept };
      return Promise.resolve(report);
    },
    cancelAll: () => {
      calls.push({ type: 'cancelAll' });
      plan.clear();
      return Promise.resolve();
    },
    pending: () => Promise.resolve(sortRequests(plan.values())),
  };
}
