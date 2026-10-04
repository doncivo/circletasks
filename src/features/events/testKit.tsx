import { render } from '@testing-library/react';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { CalendarEvent, EventFields, IconRef, ReminderOffsetMin } from '../../domain/model';
import { asLocalDate, asLocalTime, type SpaceId } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import type { AppContainer } from '../app/container';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { EventEditorHost } from './EventEditorHost';
import { EventsScreen } from './EventsScreen';
import { createEventUseCases } from './eventUseCases';

/** Aides des tests d'écran Événements : mêmes briques que l'écran Aujourd'hui (base en mémoire, conteneur), données posées par le cas d'usage. */
export { mockViewport, teardownToday as teardownEvents };
export type { TodayHarness as EventsHarness };

/**
 * Base et conteneur de test. Les calendriers de jours fériés sont désactivés d'office pour que les listes d'événements des tests de
 * E-01 et E-02 ne portent que leurs propres lignes ; `{ holidays: true }` garde les deux calendriers activés (défaut de l'app, E-03).
 */
export async function setupEvents(deviceSuffix: string, startAt = '2026-10-02T10:00:00.000Z', options: { readonly holidays?: boolean } = {}): Promise<TodayHarness> {
  const harness = await setupToday(deviceSuffix, startAt);
  if (!options.holidays) await harness.container.data.repos.settings.set('holidays.countries', { FR: false, TN: false });
  return harness;
}

export function renderEvents(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <EventsScreen />
      <EventEditorHost />
      <UndoToast />
    </AppContainerProvider>,
  );
}

export interface SeedEvent {
  readonly title: string;
  /** Jour de début ('YYYY-MM-DD'). */
  readonly date: string;
  readonly endDate?: string;
  /** Heures 'HH:mm' ; sans elles, journée entière. */
  readonly start?: string;
  readonly end?: string;
  readonly repeat?: EventFields['repeat'];
  readonly kind?: EventFields['kind'];
  readonly birthYear?: number | null;
  readonly important?: boolean;
  readonly spaceId?: SpaceId;
  readonly icon?: IconRef | null;
  readonly reminderOffsets?: readonly ReminderOffsetMin[];
}

/** Crée un événement local (Pro par défaut) par le cas d'usage, rappels compris. */
export async function seedEvent(h: TodayHarness, seed: SeedEvent): Promise<CalendarEvent> {
  h.db.clock.advance(1);
  const timed = seed.start !== undefined;
  const result = await createEventUseCases(h.container).create({
    fields: {
      spaceId: seed.spaceId ?? SPACE_PRO_ID,
      title: seed.title,
      startDate: asLocalDate(seed.date),
      startTime: timed ? asLocalTime(seed.start as string) : null,
      endDate: asLocalDate(seed.endDate ?? seed.date),
      endTime: timed ? asLocalTime(seed.end ?? (seed.start as string)) : null,
      allDay: !timed,
      kind: seed.kind ?? 'event',
      repeat: seed.repeat ?? 'once',
      important: seed.important ?? false,
      icon: seed.icon ?? null,
      birthYear: seed.birthYear ?? null,
    },
    reminderOffsets: seed.reminderOffsets ?? [],
  });
  if (!result.ok) throw new Error(`création impossible : ${result.error}`);
  return result.value;
}
