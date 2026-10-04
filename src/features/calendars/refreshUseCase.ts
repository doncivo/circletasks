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

/** Résultat d'un rafraîchissement ; `gone` : le compte a été supprimé pendant la lecture (rien n'a été écrit, l'état n'est pas à mettre à jour). */
export type RefreshResult = RefreshOutcome & { readonly gone?: true };

export async function refreshAccount(deps: RefreshDeps, accountId: CalendarAccountId): Promise<RefreshResult> {
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
  const vanished: string[] = [];
  for (const calendar of account.calendars.filter((candidate) => candidate.shown)) {
    const key = cursorKey(account.id, calendar.id);
    const fetched = await provider.fetchEvents(calendar.id, range, deps.cursors.get(key) ?? null);
    if (!fetched.ok) {
      if (stoppingErrors.has(fetched.error.kind)) return { ok: false, at, error: fetched.error };
      // Agenda supprimé côté serveur : ses événements sont vidés ; accès refusé ou réponse illisible : l'ancien contenu reste.
      if (fetched.error.kind === 'not-found') vanished.push(calendar.id);
      continue;
    }
    if (fetched.value.kind === 'unchanged') unchanged.push({ calendarId: calendar.id, cursor: fetched.value.cursor });
    else results.push({ calendarId: calendar.id, result: fetched.value });
  }

  const syncedAt = new Date(container.clock.nowMs()).toISOString() as IsoDateTime;
  // Les agendas affichés sont relus DANS la transaction : un compte supprimé ou un agenda masqué pendant la lecture réseau n'est
  // pas réécrit (course suppression / masquage / rafraîchissement).
  let gone = false;
  const stillShown = new Set<string>();
  try {
    await container.data.transaction(async (repos) => {
      const live = await repos.calendarAccounts.getById(account.id);
      if (!live) {
        gone = true;
        return;
      }
      for (const calendar of live.calendars) {
        if (calendar.shown) stillShown.add(calendar.id);
        else await repos.externalEvents.deleteForCalendar(account.id, calendar.id);
      }
      for (const calendarId of vanished) if (stillShown.has(calendarId)) await repos.externalEvents.deleteForCalendar(account.id, calendarId);
      for (const { calendarId, result } of results) {
        if (stillShown.has(calendarId)) await repos.externalEvents.replaceWindow(account.id, calendarId, toExternalEvents(account.id, result.events, syncedAt), window);
      }
    });
  } catch {
    // Écriture impossible : l'ancien état reste (la transaction est annulée) ; l'état du compte ne change pas.
    return { ok: false, at, error: { kind: 'malformed' } };
  }
  if (gone) return { ok: true, at, gone: true };
  // Un agenda masqué (ou disparu) puis réaffiché doit être relu en entier : son curseur est oublié.
  for (const calendar of account.calendars) if (!stillShown.has(calendar.id)) deps.cursors.delete(cursorKey(account.id, calendar.id));
  for (const calendarId of vanished) deps.cursors.delete(cursorKey(account.id, calendarId));
  for (const { calendarId, result } of results.filter((entry) => stillShown.has(entry.calendarId))) deps.cursors.set(cursorKey(account.id, calendarId), result.cursor);
  for (const { calendarId, cursor } of unchanged.filter((entry) => stillShown.has(entry.calendarId))) deps.cursors.set(cursorKey(account.id, calendarId), cursor);
  emitEventsChanged(container.data);
  return { ok: true, at: new Date(container.clock.nowMs()).toISOString() as IsoDateTime };
}
