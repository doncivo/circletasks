import { CalendarPlatformError, type CalendarEndpoints, type CalendarHttp, type CalendarPlatform, type OAuthFlow, type SecretVault, type TokenRef } from './types';

/**
 * Plateforme d'agendas pour le navigateur de dev, Vitest et Playwright (ADR 0008) : coffre en mémoire (perdu à la fermeture),
 * HTTP par `fetch` vers les simulateurs (tests/sim), OAuth simulé. Jamais utilisée dans l'app installée.
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

  /** Lecture réservée au transport mémoire (équivalent du côté Rust) ; jamais exposée par `SecretVault`. */
  read(ref: TokenRef): string | null {
    return this.entries.get(ref) ?? null;
  }
}

/**
 * Transport `fetch` vers les simulateurs : ajoute l'authentification lue dans `vault`, n'accepte que `allowedOrigins`
 * (origines des simulateurs). À implémenter par calendar-integration (K-01).
 */
export function createMemoryCalendarHttp(_vault: MemorySecretVault, _allowedOrigins: readonly string[]): CalendarHttp {
  return {
    request: () => Promise.reject(new CalendarPlatformError('unsupported')),
  };
}

/** OAuth simulé : appelle l'autorisation et l'échange de code du simulateur Google, range le jeton dans `vault`. À implémenter (K-01). */
export function createMemoryOAuthFlow(_vault: MemorySecretVault, _endpoints: CalendarEndpoints): OAuthFlow {
  return {
    authorizeGoogle: () => Promise.reject(new CalendarPlatformError('unsupported')),
    revokeGoogle: () => Promise.reject(new CalendarPlatformError('unsupported')),
  };
}

export function createMemoryCalendarPlatform(endpoints: CalendarEndpoints): CalendarPlatform {
  const vault = new MemorySecretVault();
  const allowed = [endpoints.googleApiBase, endpoints.caldavBase].map((base) => new URL(base).origin);
  return { vault, http: createMemoryCalendarHttp(vault, allowed), oauth: createMemoryOAuthFlow(vault, endpoints), endpoints };
}
