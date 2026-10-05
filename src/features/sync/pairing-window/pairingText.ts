import { syncErrorCodeOf } from '../../../platform/sync/types';
import { syncPairingWindowEn } from '../../../i18n/en.syncPairing';
import { syncPairingWindowFr } from '../../../i18n/fr.syncPairing';

/**
 * Textes de la fenêtre `pairing` (Y-06 critère 22, décision D6) : lus directement dans `src/i18n/{fr,en}.syncPairing.ts` (`syncPairingWindow*`), sans le reste
 * de `src/i18n`, pour tenir la liste blanche du bundle. Le français est la langue de l'app ; l'anglais (option) n'est choisi que si
 * la page l'annonce (`<html lang="en">`).
 */
export type PairingTexts = typeof syncPairingWindowFr;

export function pairingTexts(lang: string = typeof document === 'undefined' ? 'fr' : document.documentElement.lang): PairingTexts {
  return (lang.startsWith('en') ? syncPairingWindowEn : syncPairingWindowFr) as PairingTexts;
}

/** `{name}` remplacé par sa valeur (même syntaxe que `src/i18n`). */
export function fill(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Texte d'une erreur de la fenêtre (jamais le message technique, jamais l'entrée). */
export function pairingErrorText(texts: PairingTexts, error: unknown): string {
  switch (syncErrorCodeOf(error)) {
    case 'invalid-pairing':
      return texts.errors.invalidPairing;
    case 'key-mismatch':
      return texts.errors.keyMismatch;
    case 'cloud-pending':
      return texts.errors.cloudPending;
    case 'pairing-expired':
      return texts.errors.pairingExpired;
    case 'consent-denied':
      return texts.errors.consentDenied;
    case 'rate-limited':
      return texts.errors.rateLimited;
    case 'not-configured':
      return texts.errors.notConfigured;
    case 'wrong-window':
    case 'wrong-mode':
      return texts.errors.wrongWindow;
    default:
      return texts.errors.generic;
  }
}
