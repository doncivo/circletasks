import { compareCodeUnits } from '../../domain/compareCodeUnits';
import { isLocalDateTime } from '../../domain/types';
import { NOTIFICATION_KINDS, NOTIFICATION_LIMIT, NotificationSchedulerError, type NotificationRequest } from './types';

/**
 * Validation commune de `replace` (ADR 0012 section 4.1), partagée par l'implémentation vide, le faux et l'adaptateur réel : le PC
 * et l'iPhone refusent de la même façon une liste fautive. Lève `NotificationSchedulerError` ; ne modifie rien.
 * Ordre des refus : requête invalide, identifiant en double, dépassement du plafond.
 *
 * @param outsidePlan notifications en attente hors plan (fin de session Focus…), comptées dans les 64.
 */
export function validateRequests(requests: readonly NotificationRequest[], outsidePlan = 0): void {
  const invalid = requests.filter(
    (request) =>
      typeof request.id !== 'string' ||
      request.id === '' ||
      typeof request.fireAt !== 'string' ||
      !isLocalDateTime(request.fireAt) ||
      typeof request.title !== 'string' ||
      request.title.trim() === '' ||
      typeof request.body !== 'string' ||
      !NOTIFICATION_KINDS.includes(request.kind),
  );
  if (invalid.length > 0) throw new NotificationSchedulerError('invalid-request', invalid.map((request) => String(request.id)));

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.id)) duplicated.add(request.id);
    seen.add(request.id);
  }
  if (duplicated.size > 0) throw new NotificationSchedulerError('duplicate-id', [...duplicated].sort(compareCodeUnits));

  const room = Math.max(0, NOTIFICATION_LIMIT - Math.max(0, outsidePlan));
  if (requests.length > room) throw new NotificationSchedulerError('over-limit', requests.slice(room).map((request) => request.id));
}

/** Tri de `pending()` : échéance, puis identifiant (unités de code). */
export function sortRequests(requests: Iterable<NotificationRequest>): NotificationRequest[] {
  return [...requests].sort((a, b) => (a.fireAt !== b.fireAt ? compareCodeUnits(a.fireAt, b.fireAt) : compareCodeUnits(a.id, b.id)));
}
