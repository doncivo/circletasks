import type { CalendarAccountId, ExternalEventId, IsoDateTime, SpaceId, SyncMeta } from '../types';

/** Fournisseur d'un compte d'agenda (colonne `provider`). Le contrat d'accès au fournisseur est `CalendarProvider` (ADR 0008). */
export type CalendarProviderKind ='google' | 'icloud';

/** Un agenda d'un compte (`calendar_account.calendars`, JSON) : rattaché à un espace (ES-06) et affiché ou non. */
export interface CalendarRef {
  readonly id: string;
  readonly name: string;
  readonly spaceId: SpaceId | null;
  readonly shown: boolean;
}

/** Compte d'agenda externe (M8) : Google ou iCloud. Les jetons ne sont jamais en base (`tokenRef` désigne une entrée du coffre système). */
export interface CalendarAccount extends SyncMeta {
  readonly id: CalendarAccountId;
  readonly provider: CalendarProviderKind;
  /** Nom affiché de la source (« Google Agenda », « iCloud »). */
  readonly label: string;
  readonly tokenRef: string;
  /**
   * Identifiant Apple d'un compte iCloud (nom d'utilisateur de l'authentification Basic), colonne **locale** jamais publiée par la
   * synchro (ADR 0011 section 8, migration 0017) ; vide pour Google et pour un compte reçu d'un autre appareil (à reconnecter).
   */
  readonly username: string;
  readonly calendars: readonly CalendarRef[];
}

/**
 * Événement lu dans un agenda externe (M8), en lecture seule. Instants UTC (ISO 8601) : ils sont convertis à l'affichage dans
 * le fuseau de l'appareil (`externalEventDisplay`, T-11). Journée entière : date civile du début dans `startUtc`, date de fin
 * EXCLUE dans `endUtc` (convention Google et iCal), sans fuseau.
 */
export interface ExternalEvent {
  readonly id: ExternalEventId;
  readonly accountId: CalendarAccountId;
  readonly calendarId: string;
  readonly externalId: string;
  readonly title: string;
  readonly startUtc: string;
  readonly endUtc: string | null;
  readonly allDay: boolean;
  readonly syncedAt: IsoDateTime;
}

/** Lit la colonne JSON `calendars` ; une valeur illisible ou mal formée donne une liste vide (jamais d'exception à l'affichage). */
export function parseCalendars(json: string): CalendarRef[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const calendars: CalendarRef[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry['id'] !== 'string') continue;
    calendars.push({
      id: entry['id'],
      name: typeof entry['name'] === 'string' ? entry['name'] : '',
      spaceId: typeof entry['space_id'] === 'string' ? (entry['space_id'] as SpaceId) : null,
      shown: entry['shown'] !== false,
    });
  }
  return calendars;
}

/** Écrit la colonne JSON `calendars` (clés du PRD : id, name, space_id, shown). */
export function encodeCalendars(calendars: readonly CalendarRef[]): string {
  return JSON.stringify(calendars.map((calendar) => ({ id: calendar.id, name: calendar.name, space_id: calendar.spaceId, shown: calendar.shown })));
}
