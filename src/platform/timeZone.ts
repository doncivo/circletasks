import { isValidTimeZone } from '../domain/timeZone';

/**
 * Fuseau IANA courant du système (T-11) : `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 * Null si l'environnement ne le fournit pas ou le renvoie invalide. Ne lève jamais.
 */
export function detectTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && isValidTimeZone(tz) ? tz : null;
  } catch {
    return null;
  }
}
