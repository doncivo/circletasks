import { addDays } from '../../domain/localDate';
import type { QuietHours, Reminder, Space } from '../../domain/model';
import { effectiveFireAt, validateQuietHours, type QuietHoursError } from '../../domain/quietHours';
import type { LocalDate, LocalDateTime, LocalTime, Result, RoutineId, SpaceId, TaskId } from '../../domain/types';
import type { AppContainer } from '../app/container';

/**
 * Cas d'usage des plages silencieuses (ES-07) : enregistrer les plages d'un espace et lire l'échéance effective des rappels. Les
 * règles (validation, décalage) sont dans src/domain/quietHours.ts. Aucune notification n'est émise ici (ordre 5, iPhone seulement ;
 * le PC n'en émet jamais) : seule la donnée « échéance effective » est calculée, `fire_at` n'étant jamais modifié.
 */
export type QuietHoursUseCaseDeps = Pick<AppContainer, 'data'>;

export type SaveQuietHoursError = { readonly index: number; readonly error: QuietHoursError } | 'space-not-found';

/** Un rappel et l'échéance à laquelle l'iPhone devra le planifier. */
export interface EffectiveReminder {
  readonly reminder: Reminder;
  /** Espace de l'élément ciblé ; null pour un élément sans espace connu (événements : ordre 2). */
  readonly spaceId: SpaceId | null;
  /** `fire_at` d'origine, inchangé. */
  readonly fireAt: LocalDateTime;
  /** Échéance après plages silencieuses de l'espace (égale à `fireAt` hors plage). */
  readonly effectiveFireAt: LocalDateTime;
}

export interface QuietHoursUseCases {
  /** ES-07 critère 3 : enregistre les plages d'un espace après validation ; renvoie les espaces à jour. */
  save(spaceId: SpaceId, ranges: readonly QuietHours[]): Promise<Result<Space[], SaveQuietHoursError>>;
  /**
   * ES-07 critères 5 à 7 : rappels dont l'échéance EFFECTIVE tombe dans [from, to[ (`to` exclu), avec leur échéance d'origine.
   * Recalculée à chaque lecture depuis `fire_at` et les plages actuelles : modifier une plage met donc à jour l'échéance effective de
   * tous les rappels de l'espace sans en réécrire un seul. Sert la planification de l'ordre 5 (N-05).
   */
  listEffectiveReminders(range: { readonly from: LocalDateTime; readonly to: LocalDateTime }): Promise<EffectiveReminder[]>;
}

/** Un rappel décalé l'est d'une semaine au plus (plages continues de moins de sept jours) : la lecture remonte d'autant. */
const MAX_SHIFT_DAYS = 8;

const earlier = (moment: LocalDateTime, days: number): LocalDateTime => {
  const [date, time] = moment.split('T') as [LocalDate, LocalTime];
  return `${addDays(date, -days)}T${time}` as LocalDateTime;
};

export function createQuietHoursUseCases(deps: QuietHoursUseCaseDeps): QuietHoursUseCases {
  const { spaces, reminders, tasks, routines } = deps.data.repos;

  async function spaceOfReminder(reminder: Reminder): Promise<SpaceId | null> {
    if (reminder.targetType === 'task') return (await tasks.getById(reminder.targetId as TaskId))?.spaceId ?? null;
    if (reminder.targetType === 'routine') return (await routines.getById(reminder.targetId as RoutineId))?.spaceId ?? null;
    return null; // événements : leur module arrive à l'ordre 2 (même règle à réutiliser)
  }

  return {
    async save(spaceId, ranges) {
      const space = await spaces.getById(spaceId);
      if (!space) return { ok: false, error: 'space-not-found' };
      const checked = validateQuietHours(ranges);
      if (!checked.ok) return checked;
      await spaces.update(spaceId, { quietHours: checked.value });
      return { ok: true, value: await spaces.listAll() };
    },

    async listEffectiveReminders({ from, to }) {
      const all = await spaces.listAll();
      const quietBySpace = new Map(all.map((space) => [space.id, space.quietHours]));
      const candidates = await reminders.listBetween(earlier(from, MAX_SHIFT_DAYS), to);
      const result: EffectiveReminder[] = [];
      for (const reminder of candidates) {
        const spaceId = await spaceOfReminder(reminder);
        const effective = spaceId ? effectiveFireAt(reminder.fireAt, quietBySpace.get(spaceId) ?? []) : reminder.fireAt;
        if (effective >= from && effective < to) result.push({ reminder, spaceId, fireAt: reminder.fireAt, effectiveFireAt: effective });
      }
      return result.sort((a, b) => (a.effectiveFireAt < b.effectiveFireAt ? -1 : a.effectiveFireAt > b.effectiveFireAt ? 1 : 0));
    },
  };
}
