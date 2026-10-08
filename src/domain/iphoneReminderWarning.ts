import { STATE_REFRESH_MS } from './sync/limits';

/**
 * Avertissement du PC (N-07, ADR 0012 avenant N1.6) : un rappel proche que l'iPhone n'a peut-être pas encore reçu. Le PC n'envoie aucune
 * notification : il AFFICHE seulement. Fonction pure, sans horloge globale.
 *
 * - Un rappel est concerné s'il sonne dans moins de 2 h (`0 < échéance − maintenant < 2 h`, borne haute exclue).
 * - `no-iphone` : aucun appareil iPhone associé (ou synchro non configurée) : « ce rappel ne sonnera pas ».
 * - `stale` : aucun iPhone `active` n'a publié de synchro depuis 2 h 30 (`publishedSyncAt`, rafraîchie toutes les 30 minutes au plus :
 *   2 h plus la tolérance de rafraîchissement). Jamais une fausse alerte pour un iPhone synchronisé ; au pire 30 minutes de retard.
 * - Un iPhone `forgotten`, `expired`, `corrupt`, `foreign`, `rollback`, `newer-major` ou `clock-ahead` compte comme non synchronisé.
 * - La valeur n'est PAS `lastReadAt` : pour un autre appareil c'est l'heure de sa dernière écriture lue, pas de sa dernière synchro.
 */

export const REMINDER_WARNING_WINDOW_MS = 2 * 3_600_000;
/** Ancienneté maximale de la dernière synchro publiée d'un iPhone pour ne pas avertir : 2 h 30. */
export const IPHONE_STALE_AFTER_MS = REMINDER_WARNING_WINDOW_MS + STATE_REFRESH_MS;

export type IphoneReminderWarning = 'none' | 'stale' | 'no-iphone';

/** Appareil tel que l'affiche la synchro (sous-ensemble de `SyncDeviceStatus`). */
export interface WarningDevice {
  readonly platform: 'windows' | 'ios';
  readonly self: boolean;
  readonly status: string;
  readonly publishedSyncAt?: string | null | undefined;
  /** Faux : appareil jamais lu, cité seulement dans un accusé (ne compte pas comme iPhone associé). */
  readonly seen?: boolean | undefined;
}

export interface WarnIphoneReminderInput {
  readonly nowMs: number;
  /** Instant de l'échéance EFFECTIVE du rappel. */
  readonly fireAtMs: number;
  /** Appareils de la synchro ; vide ou absents : synchro non configurée. */
  readonly devices: readonly WarningDevice[];
}

export function isReminderWarnable(nowMs: number, fireAtMs: number): boolean {
  const ahead = fireAtMs - nowMs;
  return Number.isFinite(ahead) && ahead > 0 && ahead < REMINDER_WARNING_WINDOW_MS;
}

export function warnIphoneReminder(input: WarnIphoneReminderInput): IphoneReminderWarning {
  const { nowMs, fireAtMs, devices } = input;
  if (!isReminderWarnable(nowMs, fireAtMs)) return 'none';
  const iphones = devices.filter((device) => device.platform === 'ios' && !device.self && device.seen !== false);
  if (iphones.length === 0) return 'no-iphone';
  const synchronized = iphones.some((device) => {
    if (device.status !== 'active' || device.publishedSyncAt === null || device.publishedSyncAt === undefined) return false;
    const at = Date.parse(device.publishedSyncAt);
    return Number.isFinite(at) && at >= nowMs - IPHONE_STALE_AFTER_MS;
  });
  return synchronized ? 'none' : 'stale';
}

/** Gravité : un rappel qui ne sonnera jamais (`no-iphone`) passe avant un rappel peut-être en retard (`stale`). */
const SEVERITY: Readonly<Record<IphoneReminderWarning, number>> = { none: 0, stale: 1, 'no-iphone': 2 };

export interface WarnedReminders {
  /** L'avertissement le plus grave parmi les rappels concernés. */
  readonly warning: IphoneReminderWarning;
  /** Nombre de rappels concernés (échéance dans moins de 2 h) quand l'avertissement n'est pas `none`. */
  readonly count: number;
}

/** Plusieurs rappels d'un même élément (ou de tout l'espace de travail) : l'avertissement le plus grave et le nombre de rappels avertis. */
export function warnIphoneReminders(input: { readonly nowMs: number; readonly fireAtMs: readonly number[]; readonly devices: readonly WarningDevice[] }): WarnedReminders {
  let warning: IphoneReminderWarning = 'none';
  let count = 0;
  for (const fireAtMs of input.fireAtMs) {
    const one = warnIphoneReminder({ nowMs: input.nowMs, fireAtMs, devices: input.devices });
    if (one === 'none') continue;
    count += 1;
    if (SEVERITY[one] > SEVERITY[warning]) warning = one;
  }
  return { warning, count };
}

/** Écarte les rappels dont la tâche n'est plus à faire (terminée, supprimée) ; routines et événements restent. */
export function keepOpenTaskReminders<T extends { readonly reminder: { readonly targetType: string; readonly targetId: string } }>(items: readonly T[], openTaskIds: ReadonlySet<string>): T[] {
  return items.filter((item) => item.reminder.targetType !== 'task' || openTaskIds.has(item.reminder.targetId));
}
