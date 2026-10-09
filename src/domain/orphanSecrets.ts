import type { CalendarProviderKind } from './model';

/**
 * Secrets d'agenda orphelins (K-01, revue PR #25) : RÉFÉRENCES du coffre (jamais les secrets) d'une connexion abandonnée dont
 * l'effacement a échoué. Gardées dans le réglage local `calendars.orphanSecrets` pour survivre à un redémarrage. Règles pures.
 */
export interface OrphanSecret {
  readonly provider: CalendarProviderKind;
  readonly tokenRef: string;
}

const REF_PATTERN = /^circletasks\.calendar\.(google|icloud)\.[A-Za-z0-9-]+$/;

/** Valeur brute du réglage → entrées valables seulement (fournisseur connu, référence au format du coffre et du même fournisseur), sans doublon. */
export function parseOrphanSecrets(raw: unknown): OrphanSecret[] {
  if (!Array.isArray(raw)) return [];
  const result: OrphanSecret[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { provider, tokenRef } = item as { provider?: unknown; tokenRef?: unknown };
    if ((provider !== 'google' && provider !== 'icloud') || typeof tokenRef !== 'string') continue;
    const match = REF_PATTERN.exec(tokenRef);
    if (!match || match[1] !== provider) continue;
    if (result.some((known) => known.tokenRef === tokenRef)) continue;
    result.push({ provider, tokenRef });
  }
  return result;
}

/** Ajoute (ou remplace) une référence orpheline. */
export function withOrphan(list: readonly OrphanSecret[], orphan: OrphanSecret): OrphanSecret[] {
  return [...list.filter((known) => known.tokenRef !== orphan.tokenRef), orphan];
}

/** Retire une référence : un secret valable vient d'y être écrit (connexion réussie), ou il a été effacé. */
export function withoutOrphan(list: readonly OrphanSecret[], tokenRef: string): OrphanSecret[] {
  return list.filter((known) => known.tokenRef !== tokenRef);
}

/**
 * Une référence orpheline n'est JAMAIS celle d'un compte de cet appareil : son secret est alors valable, l'effacer casserait le compte.
 * Rend les orphelins qui ne sont la référence locale d'aucun compte.
 */
export function orphansOutsideAccounts(list: readonly OrphanSecret[], accountRefs: readonly string[]): OrphanSecret[] {
  return list.filter((orphan) => !accountRefs.includes(orphan.tokenRef));
}
