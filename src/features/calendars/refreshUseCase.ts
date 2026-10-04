import { externalFetchRange, toExternalEvents, type CalendarProvider, type ChangeCursor, type FetchEventsResult, type ProviderError } from '../../domain/calendarProvider';
import type { RefreshOutcome } from '../../domain/calendarRefresh';
import type { CalendarAccount } from '../../domain/model';
import { todayIn } from '../../domain/timeZone';
import type { CalendarAccountId, IsoDateTime } from '../../domain/types';
import type { AppContainer } from '../app/container';
import { emitEventsChanged } from '../events/eventEvents';

/**
 * Rafraîchissement d'un compte (K-01 critère 6, K-03) : lit chaque agenda affiché sur la fenêtre de K-01 D3, puis écrit TOUT dans une
 * seule transaction (critère 3 : un échec laisse l'ancien état). Les agendas masqués sont vidés (critère 4). Un échec d'un agenda
 * (accès refusé, introuvable, réponse illisible) l'ignore sans arrêter les autres ; un échec d'authentification, de réseau, de serveur ou
 * de quota arrête le compte entier : les données précédentes restent.
 */

export type FetchProvider = (account: CalendarAccount) => CalendarProvider;

export interface RefreshDeps {
  readonly container: Pick<AppContainer, 'clock' | 'data'>;
  readonly providerFor: FetchProvider;
  readonly timeZone: () => string;
  /** Curseurs de changement par agenda (K-03 D1), en mémoire : un redémarrage relit tout une fois. */
  readonly cursors: Map<string, ChangeCursor | null>;
}

const cursorKey = (accountId: CalendarAccountId, calendarId: string): string => `${accountId}|${calendarId}`;

const stoppingErrors: ReadonlySet<ProviderError['kind']> = new Set(['unauthorized', 'rate-limited', 'server', 'network']);

export async function refreshAccount(deps: RefreshDeps, accountId: CalendarAccountId): Promise<RefreshOutcome> {
  const { container } = deps;
  const startedMs = container.clock.nowMs();
  const at = new Date(startedMs).toISOString() as IsoDateTime;
  const account = await container.data.repos.calendarAccounts.getById(accountId);
  if (!account) return { ok: true, at };
  const provider = deps.providerFor(account);
  const timeZone = deps.timeZone();
  const range = externalFetchRange(todayIn(container.clock, timeZone), timeZone);
  const window = { from: range.fromUtc, to: range.toUtc };

  const results: { readonly calendarId: string; readonly result: Extract<FetchEventsResult, { kind: 'full' }> }[] = [];
  const unchanged: { readonly calendarId: string; readonly cursor: ChangeCursor | null }[] = [];
  for (const calendar of account.calendars.filter((candidate) => candidate.shown)) {
    const key = cursorKey(account.id, calendar.id);
    const fetched = await provider.fetchEvents(calendar.id, range, deps.cursors.get(key) ?? null);
    if (!fetched.ok) {
      if (stoppingErrors.has(fetched.error.kind)) return { ok: false, at, error: fetched.error };
      continue;
    }
    if (fetched.value.kind === 'unchanged') unchanged.push({ calendarId: calendar.id, cursor: fetched.value.cursor });
    else results.push({ calendarId: calendar.id, result: fetched.value });
  }

  const syncedAt = new Date(container.clock.nowMs()).toISOString() as IsoDateTime;
  try {
    await container.data.transaction(async (repos) => {
      for (const calendar of account.calendars.filter((candidate) => !candidate.shown)) await repos.externalEvents.deleteForCalendar(account.id, calendar.id);
      for (const { calendarId, result } of results) {
        await repos.externalEvents.replaceWindow(account.id, calendarId, toExternalEvents(account.id, result.events, syncedAt), window);
      }
    });
  } catch {
    // Écriture impossible : l'ancien état reste (la transaction est annulée) ; l'état du compte ne change pas.
    return { ok: false, at, error: { kind: 'malformed' } };
  }
  // Un agenda masqué puis réaffiché doit être relu en entier : son curseur est oublié.
  for (const calendar of account.calendars.filter((candidate) => !candidate.shown)) deps.cursors.delete(cursorKey(account.id, calendar.id));
  for (const { calendarId, result } of results) deps.cursors.set(cursorKey(account.id, calendarId), result.cursor);
  for (const { calendarId, cursor } of unchanged) deps.cursors.set(cursorKey(account.id, calendarId), cursor);
  emitEventsChanged(container.data);
  return { ok: true, at: new Date(container.clock.nowMs()).toISOString() as IsoDateTime };
}
