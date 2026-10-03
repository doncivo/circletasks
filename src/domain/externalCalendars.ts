import type { CalendarAccount, CalendarRef, ExternalEvent, Space } from './model';
import { defaultSpaceFor } from './spaceRules';
import type { Result, SpaceId } from './types';

/**
 * Agendas externes rattachés à un espace (ES-06, PRD section 6). Aucun agenda ne peut être connecté avant K-01 / K-02 (ordre 2) :
 * ce module ne porte que le modèle et les règles, sans écran.
 *
 * `ExternalCalendarRef` est l'agenda d'un compte (`calendar_account.calendars`, JSON : id, name, space_id, shown). La fiche le nomme
 * « visible » (`visible`) ; le modèle du PRD et la base disent `shown` (« affiché ») : même notion, un seul nom dans le code.
 */
export type ExternalCalendarRef = CalendarRef;

export type CalendarRefError = 'space-required' | 'unknown-space';

/**
 * Validation d'un agenda (ES-06 critère 2) : tout agenda AFFICHÉ a un espace existant. Un agenda masqué peut rester sans espace (il
 * n'apparaît nulle part) ; un espace inconnu est refusé dans tous les cas.
 */
export function validateCalendarRef(calendar: ExternalCalendarRef, spaces: readonly Pick<Space, 'id'>[]): Result<ExternalCalendarRef, CalendarRefError> {
  if (calendar.spaceId === null) return calendar.shown ? { ok: false, error: 'space-required' } : { ok: true, value: calendar };
  return spaces.some((space) => space.id === calendar.spaceId) ? { ok: true, value: calendar } : { ok: false, error: 'unknown-space' };
}

/** Valide la liste des agendas d'un compte ; renvoie le premier agenda refusé. */
export function validateCalendars(
  calendars: readonly ExternalCalendarRef[],
  spaces: readonly Pick<Space, 'id'>[],
): Result<readonly ExternalCalendarRef[], { readonly calendarId: string; readonly error: CalendarRefError }> {
  for (const calendar of calendars) {
    const checked = validateCalendarRef(calendar, spaces);
    if (!checked.ok) return { ok: false, error: { calendarId: calendar.id, error: checked.error } };
  }
  return { ok: true, value: calendars };
}

/**
 * Espace d'un événement externe (ES-06) : celui de son agenda ; l'événement n'a pas d'espace propre. null si le compte ou l'agenda
 * est inconnu, ou si l'agenda n'est rattaché à aucun espace.
 */
export function spaceOfExternalEvent(event: Pick<ExternalEvent, 'accountId' | 'calendarId'>, accounts: readonly Pick<CalendarAccount, 'id' | 'calendars'>[]): SpaceId | null {
  const account = accounts.find((candidate) => candidate.id === event.accountId);
  return account?.calendars.find((calendar) => calendar.id === event.calendarId)?.spaceId ?? null;
}

/**
 * Espace proposé à un agenda qui vient d'être connecté (T-01 : Pro, ES-06 critère 5) : les agendas sans espace reçoivent l'espace par
 * défaut ; ceux déjà rattachés gardent le leur.
 */
export function prefillCalendarSpaces(calendars: readonly ExternalCalendarRef[], spaces: readonly Pick<Space, 'id' | 'sortOrder'>[]): ExternalCalendarRef[] {
  const fallback = defaultSpaceFor('all', spaces);
  return calendars.map((calendar) => (calendar.spaceId === null ? { ...calendar, spaceId: fallback } : calendar));
}
