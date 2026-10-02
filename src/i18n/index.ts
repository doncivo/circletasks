import { en } from './en';
import { fr } from './fr';
import type { Locale, MessageKey, Messages, TArgs } from './types';

export type { Locale, MessageKey, MessageParams, Messages, PlainMessageKey } from './types';

const catalogs: Record<Locale, Messages> = { fr, en };

export const DEFAULT_LOCALE: Locale = 'fr';
let current: Locale = DEFAULT_LOCALE;

export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function interpolate(text: string, params: Record<string, string | number> | undefined): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function translateRaw(locale: Locale, key: MessageKey, params: Record<string, string | number> | undefined): string {
  const text = lookup(catalogs[locale], key) ?? lookup(fr, key) ?? key;
  return interpolate(text, params);
}

/** Traduit une clé dans une langue donnée ; repli sur le français, puis sur la clé. */
export function translate<K extends MessageKey>(locale: Locale, key: K, ...args: TArgs<K>): string {
  return translateRaw(locale, key, args[0]);
}

/**
 * Traduction d'une clé connue seulement à l'exécution (tables de configuration,
 * libellés d'annulation) : paramètres optionnels, un paramètre manquant reste
 * visible sous la forme `{nom}`. Préférer `t()` quand la clé est un littéral.
 */
export function tDynamic(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  return translateRaw(current, key, params as Record<string, string | number> | undefined);
}

/** Traduit une clé dans la langue courante. */
export function t<K extends MessageKey>(key: K, ...args: TArgs<K>): string {
  return translate(current, key, ...args);
}
