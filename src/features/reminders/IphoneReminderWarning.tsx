import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { warnIphoneReminders, type IphoneReminderWarning as Warning, type WarningDevice } from '../../domain/iphoneReminderWarning';
import { fireAtInstant, fireAtInstantLocal, localDateTimeAt } from '../../domain/notificationInstant';
import { effectiveFireAt } from '../../domain/quietHours';
import { isReminderOffset, type QuietHours, type ReminderOffsetMin } from '../../domain/model';
import { reminderFireAt } from '../../domain/recurrenceNext';
import { isValidTimeZone } from '../../domain/timeZone';
import type { LocalDate, LocalDateTime, LocalTime, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import type { AppContainer } from '../app/container';
import './IphoneReminderWarning.css';

/** Période du recalcul : une minute, par l'horloge de l'application (minuterie arrêtée au démontage). */
export const WARNING_TICK_MS = 60_000;

const NO_DEVICES: readonly SyncDeviceStatus[] = [];
/** Référence stable pour le sélecteur du magasin (un `[]` neuf à chaque appel relancerait le rendu sans fin). */
const NO_QUIET_HOURS: readonly QuietHours[] = [];
const noop = (): (() => void) => () => undefined;

export interface WarningContext {
  /** Faux sur l'iPhone : la planification y est locale, aucun avertissement N-07 n'y est produit. */
  readonly enabled: boolean;
  readonly nowMs: number;
  readonly devices: readonly WarningDevice[];
  /** Instant d'une échéance flottante, dans le fuseau de l'appareil (décalage courant du moteur si le fuseau est illisible). */
  readonly instantOf: (fireAt: LocalDateTime) => number;
  /** Heure locale flottante d'un instant, dans le même fuseau. */
  readonly localAt: (ms: number) => LocalDateTime;
}

/**
 * Contexte de l'avertissement N-07 : appareils de la synchro (recalculé à chaque changement de `SyncStatus`, donc quand l'iPhone se
 * synchronise) et instant courant (recalculé à chaque minute de l'horloge de l'application). Le PC ne fait qu'AFFICHER.
 */
export function useWarningContext(): WarningContext {
  const container: AppContainer = useAppContainer();
  const sync = container.sync;
  const status = useSyncExternalStore(sync ? sync.subscribe : noop, () => sync?.status() ?? null);
  const enabled = container.platform.os !== 'ios';
  // Recalcul à chaque minute de l'horloge de l'application : la minuterie ne sert qu'à relancer le rendu et s'arrête au démontage.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = setInterval(() => setTick((tick) => tick + 1), WARNING_TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);
  // Résolution à la minute (comme le planificateur) : l'instant ne change pas à chaque rendu, il sert de dépendance aux effets.
  const nowMs = Math.floor(container.clock.nowMs() / WARNING_TICK_MS) * WARNING_TICK_MS;
  const devices: readonly WarningDevice[] = status?.devices ?? NO_DEVICES;
  const zoneName = container.notificationClock.zone();
  const zone = zoneName !== null && isValidTimeZone(zoneName) ? zoneName : null;
  // Fonctions stables tant que le fuseau ne change pas (elles sont des dépendances d'effets).
  const conversions = useMemo(
    () => ({
      instantOf: (fireAt: LocalDateTime): number => (zone === null ? fireAtInstantLocal(fireAt) : fireAtInstant(fireAt, zone)),
      localAt: (ms: number): LocalDateTime => localDateTimeAt(ms, zone),
    }),
    [zone],
  );
  return { enabled, nowMs, devices, ...conversions };
}

/** Texte de l'avertissement d'un rappel (bloc Rappel, ligne « Rappels » du détail). */
export const warningText = (warning: Exclude<Warning, 'none'>): string => t(warning === 'stale' ? 'reminders.status.warnStale' : 'reminders.status.warnNoIphone');

export interface IphoneReminderWarningProps {
  /** Espace de l'élément (ses plages silencieuses décalent le rappel) ; null : pas encore choisi. */
  readonly spaceId: SpaceId | null;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly offsets: readonly ReminderOffsetMin[];
}

/**
 * Avertissement N-07 d'un élément (PC) : « Aucun iPhone associé : ce rappel ne sonnera pas » ou « L'iPhone ne s'est pas synchronisé depuis
 * plus de 2 h : ce rappel pourrait ne pas sonner à l'heure », quand un de ses rappels sonne dans moins de 2 h. Persistant tant que la
 * condition dure : disparaît quand l'iPhone se synchronise, ou que le rappel est passé, supprimé ou terminé (l'appelant ne le monte pas).
 */
export function IphoneReminderWarning({ spaceId, date, time, offsets }: IphoneReminderWarningProps) {
  const context = useWarningContext();
  const quietHours = useAppStore((state) => (spaceId === null ? undefined : state.spaces.find((space) => space.id === spaceId))?.quietHours ?? NO_QUIET_HOURS);
  if (!context.enabled || date === null || time === null || offsets.length === 0) return null;
  const fireAtMs = offsets.filter(isReminderOffset).map((offset) => context.instantOf(effectiveFireAt(reminderFireAt(date, time, offset), quietHours)));
  const { warning } = warnIphoneReminders({ nowMs: context.nowMs, fireAtMs, devices: context.devices });
  if (warning === 'none') return null;
  return (
    <p className="ct-reminder-warning" role="status" data-warning={warning}>
      {warningText(warning)}
    </p>
  );
}
