import { pluginDate } from '../../domain/notificationInstant';
import { isValidTimeZone } from '../../domain/timeZone';
import type { NotificationClock } from '../notifications/notificationClock';
import type { LedgerStore } from '../notifications/notificationLedger';
import { SEND_MARGIN_MS, VERIFY_GRACE_MS, type IosNotificationBridge } from '../notifications/tauriNotifications';
import { NotificationSchedulerError } from '../notifications/types';
import type { FocusEndScheduler } from './types';

/**
 * Notification de fin de session Focus sur l'iPhone (F-04 critères 11 à 16, ADR 0012 avenant N1.7). Même plugin que les rappels, par le
 * pont de `tauriNotifications.ts`, mais identifiant numérique RÉSERVÉ 1 : ni `replace` ni `cancelAll` du plan n'y touchent. Pas de
 * catégorie, pas de plage silencieuse. Un rejet est typé (`NotificationSchedulerError`) : le cas d'usage Focus l'attrape et l'affiche.
 */

/** Identifiant numérique de la fin de session (plage réservée [1 ; 65 535]). */
export const FOCUS_END_NUMERIC_ID = 1;

export interface FocusEndDeps {
  readonly bridge: IosNotificationBridge;
  readonly ledger: LedgerStore;
  readonly clock: NotificationClock;
  /** Textes (src/i18n, composés par la feature) : titre « Session terminée · {durée} », corps = titre de la tâche. */
  readonly compose: (taskTitle: string, plannedMin: number | null) => { readonly title: string; readonly body: string };
}

export function createTauriFocusEndScheduler(deps: FocusEndDeps): FocusEndScheduler {
  const { bridge, ledger, clock } = deps;

  const cancelPlugin = async (): Promise<void> => {
    try {
      await bridge.cancel([FOCUS_END_NUMERIC_ID]);
    } catch (error) {
      throw error instanceof NotificationSchedulerError ? error : new NotificationSchedulerError('schedule-failed');
    }
  };

  const writeLedger = async (focusEnd: { sessionId: string; at: number } | null): Promise<void> => {
    try {
      await ledger.update((current) => ({ ...current, focusEnd }));
    } catch {
      throw new NotificationSchedulerError('ledger-failed');
    }
  };

  return {
    async schedule(sessionId, fireAt, title, plannedMin = null) {
      const at = fireAt.getTime();
      let granted: string;
      try {
        granted = await bridge.permission();
      } catch (error) {
        throw error instanceof NotificationSchedulerError ? error : new NotificationSchedulerError('unavailable');
      }
      if (granted !== 'granted') throw new NotificationSchedulerError('permission-denied');
      // Échéance déjà passée (ou sur le point de l'être) : rien n'est envoyé, l'éventuelle notification précédente est retirée.
      if (at <= clock.nowMs() + SEND_MARGIN_MS) {
        await cancelPlugin();
        await writeLedger(null);
        return;
      }
      const zoneName = clock.zone();
      const zone = zoneName !== null && isValidTimeZone(zoneName) ? zoneName : null;
      const text = deps.compose(title, plannedMin);
      try {
        await bridge.show({
          id: FOCUS_END_NUMERIC_ID,
          title: text.title,
          body: text.body,
          sound: 'default',
          extra: { sid: `focus:${sessionId}`, at: String(at) },
          // Constat 7 : même un `Date` s'écrit en heure murale du fuseau courant.
          schedule: { at: { date: pluginDate(at, zone), repeating: false, allowWhileIdle: false } },
        });
      } catch (error) {
        throw error instanceof NotificationSchedulerError ? error : new NotificationSchedulerError('schedule-failed');
      }
      let pending;
      try {
        pending = await bridge.pending();
      } catch {
        throw new NotificationSchedulerError('verify-failed');
      }
      if (!pending.some((item) => item.id === FOCUS_END_NUMERIC_ID) && at > clock.nowMs() + VERIFY_GRACE_MS) throw new NotificationSchedulerError('verify-failed');
      await writeLedger({ sessionId, at });
    },

    async cancel(sessionId) {
      const read = await ledger.read();
      // Ne retire que la notification de CETTE session (une autre session a pu la remplacer).
      if (read.state !== 'valid' || read.ledger.focusEnd?.sessionId !== sessionId) return;
      await cancelPlugin();
      await writeLedger(null);
    },
  };
}
