import { CalendarPlatformError, type CalendarAuth, type CalendarEndpoints, type CalendarHttp, type CalendarHttpMethod, type CalendarHttpRequest, type CalendarHttpResponse, type CalendarPlatform, type OAuthFlow, type SecretVault, type TokenRef } from './types';

/**
 * Plateforme d'agendas pour le navigateur de dev, Vitest et Playwright (ADR 0008) : coffre en mémoire (perdu à la fermeture),
 * HTTP par `fetch` vers les simulateurs (tests/sim), OAuth simulé. Jamais utilisée dans l'app installée. Elle reproduit le contrat
 * de la version Rust : ajout de `Authorization` à partir du coffre, rafraîchissement du jeton Google (échéance ou 401, une fois),
 * hôtes limités, `Authorization` fourni refusé, aucun secret renvoyé.
 */
export class MemorySecretVault implements SecretVault {
  private readonly entries = new Map<TokenRef, string>();

  async set(ref: TokenRef, secret: string): Promise<void> {
    this.entries.set(ref, secret);
  }

  async has(ref: TokenRef): Promise<boolean> {
    return this.entries.has(ref);
  }

  async delete(ref: TokenRef): Promise<void> {
    this.entries.delete(ref);
  }

  /** Références présentes (tests : vérifier qu'un échec n'a rien rangé) ; jamais exposée par `SecretVault`. */
  refs(): string[] {
    return [...this.entries.keys()];
  }

  /** Lecture réservée au transport mémoire (équivalent du côté Rust) ; jamais exposée par `SecretVault`. */
  read(ref: TokenRef): string | null {
    return this.entries.get(ref) ?? null;
  }
}

/** Jetons Google au format du coffre (identique à la version Rust). `expires_at` : secondes Unix. */
interface StoredTokens {
  refresh: string;
  access: string;
  expires_at: number;
}

const EXPIRY_MARGIN_SECONDS = 60;
const METHODS: readonly CalendarHttpMethod[] = ['GET', 'POST', 'PROPFIND', 'REPORT'];

export interface MemoryPlatformOptions {
  /** ID client OAuth du simulateur ; absent : `config-missing` (miroir de « non configuré »). */
  readonly googleClientId?: string | undefined;
  /** Horloge injectable (secondes Unix) pour les échéances de jeton. */
  readonly nowSeconds?: () => number;
  /** `fetch` injectable. */
  readonly fetch?: typeof fetch;
}

const nowSecondsDefault = (): number => Math.floor(Date.now() / 1000);

const toBase64Url = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function parseTokens(raw: string | null): StoredTokens {
  if (raw === null) throw new CalendarPlatformError('secret-missing');
  try {
    const value = JSON.parse(raw) as Partial<StoredTokens>;
    if (typeof value.refresh === 'string' && typeof value.access === 'string' && typeof value.expires_at === 'number') return value as StoredTokens;
  } catch {
    // Illisible : traité comme un secret à refaire.
  }
  throw new CalendarPlatformError('reauth-required');
}

async function refreshTokens(fetchFn: typeof fetch, endpoints: CalendarEndpoints, clientId: string | undefined, current: StoredTokens, now: () => number): Promise<StoredTokens> {
  if (!clientId) throw new CalendarPlatformError('config-missing');
  let response: Response;
  try {
    response = await fetchFn(endpoints.googleTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refresh, client_id: clientId }),
    });
  } catch {
    throw new CalendarPlatformError('network');
  }
  if (response.status === 400 || response.status === 401) throw new CalendarPlatformError('reauth-required');
  if (response.status !== 200) throw new CalendarPlatformError('network');
  const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!body.access_token) throw new CalendarPlatformError('network');
  return { refresh: body.refresh_token ?? current.refresh, access: body.access_token, expires_at: now() + (body.expires_in ?? 3600) };
}

/**
 * Transport `fetch` vers les simulateurs : n'accepte que `allowedOrigins` (origines des simulateurs, contrôle aussi la cible finale
 * d'une redirection) et ajoute l'authentification lue dans `vault`.
 */
export function createMemoryCalendarHttp(vault: MemorySecretVault, allowedOrigins: readonly string[], endpoints?: CalendarEndpoints, options: MemoryPlatformOptions = {}): CalendarHttp {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.nowSeconds ?? nowSecondsDefault;
  const allowed = new Set(allowedOrigins);
  const send = async (request: CalendarHttpRequest, authorization: string): Promise<CalendarHttpResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 20_000);
    try {
      const response = await fetchFn(request.url, { method: request.method, headers: { ...request.headers, authorization }, body: request.body, signal: controller.signal, redirect: 'follow' });
      if (response.url && !allowed.has(new URL(response.url).origin)) throw new CalendarPlatformError('host-not-allowed');
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: await response.text() };
    } catch (error) {
      if (error instanceof CalendarPlatformError) throw error;
      throw new CalendarPlatformError(controller.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
  };
  const authorizationFor = async (auth: CalendarAuth): Promise<string> => {
    if (auth.kind === 'basic') {
      const password = vault.read(auth.tokenRef);
      if (password === null) throw new CalendarPlatformError('secret-missing');
      return `Basic ${btoa(unescape(encodeURIComponent(`${auth.username}:${password}`)))}`;
    }
    let tokens = parseTokens(vault.read(auth.tokenRef));
    if (tokens.expires_at <= now() + EXPIRY_MARGIN_SECONDS) tokens = await refreshAndStore(auth.tokenRef, tokens);
    return `Bearer ${tokens.access}`;
  };
  const refreshAndStore = async (tokenRef: TokenRef, current: StoredTokens): Promise<StoredTokens> => {
    if (!endpoints) throw new CalendarPlatformError('config-missing');
    const fresh = await refreshTokens(fetchFn, endpoints, options.googleClientId, current, now);
    await vault.set(tokenRef, JSON.stringify(fresh));
    return fresh;
  };
  return {
    async request(request) {
      if (!METHODS.includes(request.method)) throw new CalendarPlatformError('unsupported');
      if (Object.keys(request.headers).some((name) => name.toLowerCase() === 'authorization')) throw new CalendarPlatformError('unsupported');
      let origin: string;
      try {
        origin = new URL(request.url).origin;
      } catch {
        throw new CalendarPlatformError('host-not-allowed');
      }
      if (!allowed.has(origin)) throw new CalendarPlatformError('host-not-allowed');
      const response = await send(request, await authorizationFor(request.auth));
      if (response.status !== 401 || request.auth.kind !== 'google-oauth') return response;
      // 401 malgré une échéance non atteinte : un seul rafraîchissement, une seule nouvelle tentative.
      const tokens = await refreshAndStore(request.auth.tokenRef, parseTokens(vault.read(request.auth.tokenRef)));
      const retried = await send(request, `Bearer ${tokens.access}`);
      if (retried.status === 401) throw new CalendarPlatformError('reauth-required');
      return retried;
    },
  };
}

/**
 * OAuth simulé : suit la redirection de consentement du simulateur (le « navigateur » est `fetch`, la redirection de retour est lue
 * dans l'URL finale), vérifie `state`, échange le code avec PKCE et range les jetons dans `vault`. Même contrat d'erreurs que Rust.
 */
export function createMemoryOAuthFlow(vault: MemorySecretVault, endpoints: CalendarEndpoints, options: MemoryPlatformOptions = {}): OAuthFlow {
  const fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.nowSeconds ?? nowSecondsDefault;
  return {
    async authorizeGoogle(tokenRef) {
      const clientId = options.googleClientId;
      if (!clientId) throw new CalendarPlatformError('config-missing');
      const random = globalThis.crypto.getRandomValues(new Uint8Array(48));
      const verifier = toBase64Url(random);
      const challenge = toBase64Url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
      const state = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(24)));
      const redirectUri = `${new URL(endpoints.googleAuthUrl).origin}/oauth/callback`;
      const url = new URL(endpoints.googleAuthUrl);
      for (const [key, value] of Object.entries({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/calendar.readonly', state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' })) {
        url.searchParams.set(key, value);
      }
      let finalUrl: URL;
      try {
        const consent = await fetchFn(url, { redirect: 'follow' });
        finalUrl = new URL(consent.url);
      } catch {
        throw new CalendarPlatformError('network');
      }
      if (finalUrl.searchParams.get('state') !== state) throw new CalendarPlatformError('state-mismatch');
      const code = finalUrl.searchParams.get('code');
      if (finalUrl.searchParams.get('error') || !code) throw new CalendarPlatformError('cancelled');
      let response: Response;
      try {
        response = await fetchFn(endpoints.googleTokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId }),
        });
      } catch {
        throw new CalendarPlatformError('network');
      }
      if (response.status !== 200) throw new CalendarPlatformError(response.status === 400 ? 'cancelled' : 'network');
      const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!body.access_token || !body.refresh_token) throw new CalendarPlatformError('network');
      await vault.set(tokenRef, JSON.stringify({ refresh: body.refresh_token, access: body.access_token, expires_at: now() + (body.expires_in ?? 3600) } satisfies StoredTokens));
    },
    async revokeGoogle(tokenRef) {
      const raw = vault.read(tokenRef);
      if (raw !== null) {
        try {
          const tokens = parseTokens(raw);
          await fetchFn(endpoints.googleRevokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh }) });
        } catch {
          // Au mieux : Google injoignable ou jeton illisible n'empêche pas l'effacement.
        }
      }
      await vault.delete(tokenRef);
    },
  };
}

export function createMemoryCalendarPlatform(endpoints: CalendarEndpoints, options: MemoryPlatformOptions = {}): CalendarPlatform & { readonly memoryVault: MemorySecretVault } {
  const vault = new MemorySecretVault();
  const allowed = [endpoints.googleAuthUrl, endpoints.googleApiBase, endpoints.googleTokenUrl, endpoints.caldavBase].map((base) => new URL(base).origin);
  return { vault, memoryVault: vault, http: createMemoryCalendarHttp(vault, allowed, endpoints, options), oauth: createMemoryOAuthFlow(vault, endpoints, options), endpoints };
}
