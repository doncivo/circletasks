import { addDays } from './localDate';
import { localToUtcMs } from './timeZone';
import type { CalendarProviderKind, ExternalEvent } from './model';
import type { CalendarAccountId, ExternalEventId, IsoDateTime, LocalDate, Result } from './types';

/**
 * Contrat d'accès aux agendas externes (M8, K-01 à K-03, ADR 0008). Le domaine ne fait aucun appel réseau : il définit ce qu'un
 * fournisseur (Google, iCloud CalDAV) rend, et comment ces données deviennent des lignes `external_event`. Les implémentations
 * (src/features/calendars/providers) reçoivent un transport HTTP de src/platform/calendars : les jetons et mots de passe n'entrent
 * jamais dans la WebView, Rust les ajoute aux requêtes à partir de `token_ref`.
 */

/** Plage lue à chaque rafraîchissement, bornes en UTC (ISO 8601, `toUtc` exclue). */
export interface FetchRange {
  readonly fromUtc: IsoDateTime;
  readonly toUtc: IsoDateTime;
}

/** K-01 D3 : fenêtre chargée, de 60 jours avant à 400 jours après aujourd'hui (date locale). */
export const EXTERNAL_WINDOW_DAYS_BEFORE = 60;
export const EXTERNAL_WINDOW_DAYS_AFTER = 400;

/**
 * Jours locaux couverts par la fenêtre (K-01 D3). La conversion en `FetchRange` UTC (fonction à ajouter dans timeZone.ts)
 * utilise le fuseau de l'appareil ; une marge d'un jour de chaque côté absorbe les décalages de fuseau.
 */
export function externalWindowDays(today: LocalDate): { readonly first: LocalDate; readonly last: LocalDate } {
  return { first: addDays(today, -EXTERNAL_WINDOW_DAYS_BEFORE), last: addDays(today, EXTERNAL_WINDOW_DAYS_AFTER) };
}

/** Agenda tel que le fournisseur le décrit (avant rattachement à un espace, ES-06). */
export interface ProviderCalendar {
  readonly id: string;
  readonly name: string;
  /** Couleur CSS (#RRGGBB) annoncée par le fournisseur, null si absente. */
  readonly color: string | null;
  /** Agenda principal Google : son identifiant est l'adresse du compte (label du `calendar_account`, K-01 critère 3). */
  readonly primary: boolean;
}

/**
 * Événement normalisé par le fournisseur : UNE instance (les séries sont développées par le serveur : `singleEvents=true` chez
 * Google, `expand` en CalDAV). Mêmes conventions que `ExternalEvent` : instants UTC ; journée entière = date civile dans
 * `startUtc` (« AAAA-MM-JJ »), fin EXCLUE dans `endUtc`.
 */
export interface ProviderEvent {
  readonly calendarId: string;
  /** Identifiant stable de l'instance : id Google de l'instance, ou UID + RECURRENCE-ID en CalDAV. */
  readonly externalId: string;
  /** Titre brut ; vide → « (Sans titre) » à l'affichage (K-02 D3, texte i18n). */
  readonly title: string;
  readonly startUtc: string;
  readonly endUtc: string | null;
  readonly allDay: boolean;
}

/**
 * Curseur de changement opaque, propre à un agenda : ctag CalDAV (K-03 D1). Google n'en fournit pas (pas de `syncToken`,
 * K-03 D1) : son curseur reste null et la fenêtre est relue en entier.
 */
export type ChangeCursor = string;

export type FetchEventsResult =
  /** Rien n'a changé depuis `cursor` : les lignes existantes restent (aucune écriture). */
  | { readonly kind: 'unchanged'; readonly cursor: ChangeCursor | null }
  /** Fenêtre complète : remplace toutes les lignes de l'agenda dans la plage (K-03 critère 3, transaction). */
  | { readonly kind: 'full'; readonly events: readonly ProviderEvent[]; readonly cursor: ChangeCursor | null };

/**
 * Erreurs d'un fournisseur, indépendantes du protocole.
 * - `unauthorized` : 401, `invalid_grant`, jeton révoqué, secret absent du coffre de CET appareil (K-01 D1) → « à reconnecter » ;
 * - `forbidden` / `not-found` : agenda retiré ou partage révoqué → l'agenda est ignoré, le compte reste connecté ;
 * - `rate-limited` : 429, `retryAfterMs` du serveur à respecter (K-03 critère 5) ;
 * - `server` (5xx), `network` (hors ligne, délai) : données conservées, état « erreur » ;
 * - `malformed` : réponse illisible (consignée, sans contenu sensible).
 */
export type ProviderError =
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number | null }
  | { readonly kind: 'server'; readonly status: number }
  | { readonly kind: 'network' }
  /** Le code du fournisseur n'a pas pu être chargé (fichier absent de la WebView) : ni réseau ni réponse du serveur. */
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'malformed' };

/** Accès en LECTURE SEULE à un compte (K-01 critère 9, K-02 critère 8). Aucune méthode d'écriture n'existe. */
export interface CalendarProvider {
  readonly kind: CalendarProviderKind;
  /** Agendas d'événements du compte (CalDAV : seulement les collections `VEVENT`, K-02 critère 4). */
  listCalendars(): Promise<Result<readonly ProviderCalendar[], ProviderError>>;
  /** Instances de `calendarId` qui recoupent `range` ; `cursor` : dernier curseur connu (null au premier passage). */
  fetchEvents(calendarId: string, range: FetchRange, cursor: ChangeCursor | null): Promise<Result<FetchEventsResult, ProviderError>>;
}

/**
 * Identifiant de ligne `external_event` DÉTERMINISTE (compte + agenda + identifiant externe) : l'upsert de K-03 garde le même id
 * (K-04 D4) et un autre appareil connecté au même compte calcule le même, donc le lien `task.external_event_id` (K-04) s'y résout.
 */
export function externalEventRowId(accountId: CalendarAccountId, calendarId: string, externalId: string): ExternalEventId {
  return [accountId, calendarId, externalId].map(encodeURIComponent).join('|') as ExternalEventId;
}

/** Instant UTC au format stocké : secondes, sans millisecondes (tri et comparaisons de chaînes cohérents avec les bornes de plage). */
export function toStoredInstant(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * Plage UTC lue à chaque rafraîchissement (K-01 D3) : de minuit local du premier jour à minuit local suivant le dernier jour, élargie
 * d'un jour de chaque côté (marge de fuseau, journées entières stockées en UTC).
 */
export function externalFetchRange(today: LocalDate, timeZone: string): FetchRange {
  const { first, last } = externalWindowDays(today);
  const day = 86_400_000;
  return {
    fromUtc: toStoredInstant(localToUtcMs(first, '00:00', timeZone) - day) as IsoDateTime,
    toUtc: toStoredInstant(localToUtcMs(addDays(last, 1), '00:00', timeZone) + day) as IsoDateTime,
  };
}

/**
 * Normalisation vers `external_event` (K-03, partagée Google / iCloud) : id déterministe, `syncedAt`, titre conservé brut (vide
 * accepté : « (Sans titre) » est un texte d'affichage). Deux instances de même identifiant : la dernière gagne.
 */
export function toExternalEvents(accountId: CalendarAccountId, events: readonly ProviderEvent[], syncedAt: IsoDateTime): ExternalEvent[] {
  const byId = new Map<ExternalEventId, ExternalEvent>();
  for (const event of events) {
    const id = externalEventRowId(accountId, event.calendarId, event.externalId);
    byId.set(id, {
      id,
      accountId,
      calendarId: event.calendarId,
      externalId: event.externalId,
      title: event.title,
      startUtc: event.startUtc,
      endUtc: event.endUtc,
      allDay: event.allDay,
      syncedAt,
    });
  }
  return [...byId.values()];
}
