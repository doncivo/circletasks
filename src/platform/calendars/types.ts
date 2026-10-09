/**
 * Contrats plateforme des agendas externes (K-01 à K-03, ADR 0008). Implémentations :
 * - Tauri (PC et iPhone) : commandes Rust `calendar_*` ; coffre système (Gestionnaire d'identification Windows, Trousseau iOS) via
 *   la crate `keyring` ; HTTP par Rust (reqwest, liste d'hôtes autorisés) ; les secrets ne reviennent JAMAIS dans la WebView ;
 * - mémoire (navigateur de dev, Vitest, Playwright) : coffre en mémoire et `fetch` vers les simulateurs de tests/sim.
 *
 * Erreurs : toute méthode rejette avec `CalendarPlatformError` (code stable, message sans secret).
 */

/** Référence d'une entrée du coffre (`calendar_account.token_ref`), ex. « circletasks.calendar.<accountId> ». */
export type TokenRef = string;

export type CalendarPlatformErrorCode =
  /** Hôte hors liste (ADR 0008) ou URL non HTTPS hors simulateur. */
  | 'host-not-allowed'
  /** Aucune entrée pour ce `token_ref` dans le coffre de CET appareil (K-01 D1) : compte « à reconnecter ». */
  | 'secret-missing'
  /** Jeton refusé et rafraîchissement OAuth impossible (`invalid_grant`). */
  | 'reauth-required'
  /** L'utilisateur a fermé ou refusé la page de consentement (K-01 critère 2 : « Connexion annulée »). */
  | 'cancelled'
  /** Paramètre `state` OAuth différent : réponse rejetée. */
  | 'state-mismatch'
  /** ID client OAuth absent du build (`CT_GOOGLE_CLIENT_ID`, attend Ali). */
  | 'config-missing'
  | 'network'
  | 'timeout'
  /** Coffre système indisponible ou refus d'accès. */
  | 'vault-unavailable'
  /** iPhone (K-TECH-01) : la feuille d'authentification web n'a pas pu s'ouvrir (aucune fenêtre, session déjà en cours). */
  | 'web-auth-unavailable'
  /** iPhone (K-TECH-01) : la session d'authentification web a échoué (erreur système, URL de retour inattendue, réponse Google refusée). */
  | 'web-auth-failed'
  | 'unsupported';

/** Échecs propres à la session d'authentification web de l'iPhone : écran Agendas « La connexion à Google n'a pas pu aboutir ». */
export type WebAuthFailureCode = Extract<CalendarPlatformErrorCode, 'web-auth-unavailable' | 'web-auth-failed'>;

export function isWebAuthFailure(code: CalendarPlatformErrorCode): code is WebAuthFailureCode {
  return code === 'web-auth-unavailable' || code === 'web-auth-failed';
}

export class CalendarPlatformError extends Error {
  constructor(readonly code: CalendarPlatformErrorCode) {
    super(`calendar-platform:${code}`);
    this.name = 'CalendarPlatformError';
  }
}

/**
 * Coffre système. Pas de `get` côté WebView : seul Rust lit un secret pour l'ajouter à une requête (K-01 critère 3 : aucun jeton
 * dans l'état de l'interface). `set` sert au mot de passe d'application iCloud saisi dans le formulaire (K-02) ; les jetons Google
 * sont écrits par Rust à la fin du flux OAuth.
 */
export interface SecretVault {
  set(ref: TokenRef, secret: string): Promise<void>;
  has(ref: TokenRef): Promise<boolean>;
  /** Idempotent : supprimer une entrée absente n'est pas une erreur. */
  delete(ref: TokenRef): Promise<void>;
}

/** Authentification ajoutée par la plateforme à partir du coffre ; la WebView ne fournit que la référence. */
export type CalendarAuth =
  /** Google : `Authorization: Bearer`, rafraîchi par Rust si expiré ou sur 401 (une seule fois). */
  | { readonly kind: 'google-oauth'; readonly tokenRef: TokenRef }
  /** iCloud CalDAV : `Authorization: Basic` (identifiant Apple + mot de passe d'application du coffre). */
  | { readonly kind: 'basic'; readonly tokenRef: TokenRef; readonly username: string };

export type CalendarHttpMethod = 'GET' | 'POST' | 'PROPFIND' | 'REPORT';

export interface CalendarHttpRequest {
  readonly method: CalendarHttpMethod;
  /** URL absolue HTTPS d'un hôte autorisé (ADR 0008) ; redirections suivies seulement vers un hôte autorisé. */
  readonly url: string;
  /** En-têtes sans `Authorization` (refusé : la plateforme l'ajoute). Ex. `Depth`, `Content-Type`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly auth: CalendarAuth;
  /** Délai maximal en ms (défaut 20 000). */
  readonly timeoutMs?: number;
}

export interface CalendarHttpResponse {
  readonly status: number;
  /** Noms en minuscules (`retry-after`, `etag`, `location`). */
  readonly headers: Readonly<Record<string, string>>;
  /** Corps texte (JSON Google, XML CalDAV, ICS). */
  readonly body: string;
}

/** Transport HTTP des fournisseurs : un 4xx/5xx est une réponse, pas une erreur ; erreurs = `CalendarPlatformError`. */
export interface CalendarHttp {
  request(request: CalendarHttpRequest): Promise<CalendarHttpResponse>;
}

/**
 * Flux OAuth Google (portée `calendar.readonly` seule, K-01 critère 9), PKCE S256 + `state`, sans secret client embarqué :
 * - PC : navigateur système + redirection boucle locale `http://127.0.0.1:<port libre>/` (Rust) ;
 * - iPhone (K-TECH-01, ADR 0008 §9) : ASWebAuthenticationSession (plugin Swift `web-auth`, appelé par Rust seul), ID client « iOS »
 *   sans secret, redirection `com.googleusercontent.apps.<id>:/oauth2redirect`.
 * Le code est échangé par Rust ; les jetons vont au coffre sous `tokenRef`. Rejette `cancelled`, `state-mismatch`,
 * `config-missing`, `network`, `timeout` (5 min sans réponse, PC seulement), `web-auth-unavailable` et `web-auth-failed` (iPhone).
 */
export interface OAuthFlow {
  authorizeGoogle(tokenRef: TokenRef): Promise<void>;
  /** Révocation côté Google (au mieux) puis effacement du coffre (K-01 critère 8) ; ne rejette pas si Google est injoignable. */
  revokeGoogle(tokenRef: TokenRef): Promise<void>;
}

/** Points d'accès des fournisseurs : réels en production, simulateurs en dev et en test (tests/sim). */
export interface CalendarEndpoints {
  readonly googleAuthUrl: string;
  readonly googleTokenUrl: string;
  readonly googleRevokeUrl: string;
  readonly googleApiBase: string;
  readonly caldavBase: string;
}

export const PRODUCTION_ENDPOINTS: CalendarEndpoints = {
  googleAuthUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  googleTokenUrl: 'https://oauth2.googleapis.com/token',
  googleRevokeUrl: 'https://oauth2.googleapis.com/revoke',
  googleApiBase: 'https://www.googleapis.com/calendar/v3',
  caldavBase: 'https://caldav.icloud.com',
};

/** Points d'accès d'un simulateur Google et d'un simulateur CalDAV (tests/sim), mêmes chemins que les vrais. */
export function simulatorEndpoints(googleSimBase: string, caldavSimBase: string): CalendarEndpoints {
  return {
    googleAuthUrl: `${googleSimBase}/o/oauth2/v2/auth`,
    googleTokenUrl: `${googleSimBase}/token`,
    googleRevokeUrl: `${googleSimBase}/revoke`,
    googleApiBase: `${googleSimBase}/calendar/v3`,
    caldavBase: caldavSimBase,
  };
}

export interface CalendarPlatform {
  readonly vault: SecretVault;
  readonly http: CalendarHttp;
  readonly oauth: OAuthFlow;
  readonly endpoints: CalendarEndpoints;
}
