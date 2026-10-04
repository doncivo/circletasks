import type { ProviderError } from '../../../domain/calendarProvider';
import type { Result } from '../../../domain/types';
import { CalendarPlatformError, type CalendarHttp, type CalendarHttpRequest, type CalendarHttpResponse } from '../../../platform/calendars';

/**
 * Passage du transport (`CalendarHttp`) aux erreurs de fournisseur (`ProviderError`), commun à Google et CalDAV. Aucun contenu de
 * réponse, d'en-tête ni de secret n'entre dans une erreur : seulement un type.
 */

/** Erreur de plateforme → erreur de fournisseur. Secret absent, jeton irrécupérable, configuration ou coffre : « à reconnecter ». */
export function platformErrorToProviderError(error: unknown): ProviderError {
  if (!(error instanceof CalendarPlatformError)) return { kind: 'network' };
  switch (error.code) {
    case 'secret-missing':
    case 'reauth-required':
    case 'config-missing':
    case 'vault-unavailable':
      return { kind: 'unauthorized' };
    case 'network':
    case 'timeout':
      return { kind: 'network' };
    default:
      return { kind: 'malformed' };
  }
}

/** « Retry-After » en secondes (ou date HTTP) → millisecondes ; null si absent ou illisible. */
export function retryAfterMs(response: CalendarHttpResponse, nowMs: number): number | null {
  const raw = response.headers['retry-after'];
  if (raw === undefined) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** Statut HTTP d'échec → erreur de fournisseur (null : succès). 403 : refusé pour l'agenda, sauf quota Google (`rateLimited`). */
export function statusToProviderError(response: CalendarHttpResponse, nowMs: number, options: { readonly rateLimited403?: (body: string) => boolean } = {}): ProviderError | null {
  const { status } = response;
  if (status >= 200 && status < 300) return null;
  if (status === 401) return { kind: 'unauthorized' };
  if (status === 403) return options.rateLimited403?.(response.body) ? { kind: 'rate-limited', retryAfterMs: retryAfterMs(response, nowMs) } : { kind: 'forbidden' };
  if (status === 404 || status === 410) return { kind: 'not-found' };
  if (status === 429) return { kind: 'rate-limited', retryAfterMs: retryAfterMs(response, nowMs) };
  if (status >= 500) return { kind: 'server', status };
  return { kind: 'malformed' };
}

export interface CallOptions {
  readonly nowMs?: () => number;
  readonly rateLimited403?: (body: string) => boolean;
  /** Statuts de succès supplémentaires (CalDAV : 207). */
  readonly okStatuses?: readonly number[];
}

/** Envoie une requête et range échec de plateforme ou statut d'erreur dans un `Result`. */
export async function callProvider(http: CalendarHttp, request: CalendarHttpRequest, options: CallOptions = {}): Promise<Result<CalendarHttpResponse, ProviderError>> {
  let response: CalendarHttpResponse;
  try {
    response = await http.request(request);
  } catch (error) {
    return { ok: false, error: platformErrorToProviderError(error) };
  }
  if (options.okStatuses?.includes(response.status)) return { ok: true, value: response };
  const failure = statusToProviderError(response, (options.nowMs ?? Date.now)(), options.rateLimited403 ? { rateLimited403: options.rateLimited403 } : {});
  return failure ? { ok: false, error: failure } : { ok: true, value: response };
}

/** JSON illisible : `undefined` (l'appelant répond `malformed`). */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
