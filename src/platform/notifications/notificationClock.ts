import { detectTimeZone } from '../timeZone';

/**
 * Horloge de l'adaptateur de notifications (ADR 0012 avenant N1.2) : instant courant et fuseau IANA de l'appareil, injectables pour que
 * les tests ne dépendent ni de `Date.now` ni de la variable `TZ`. `zone()` rend null quand le fuseau est illisible (N-06 critère 3).
 */
export interface NotificationClock {
  nowMs(): number;
  zone(): string | null;
}

export const systemNotificationClock: NotificationClock = {
  nowMs: () => Date.now(),
  zone: () => detectTimeZone(),
};
