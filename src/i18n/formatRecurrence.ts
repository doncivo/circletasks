import type { MessageParam, MessageRef } from '../domain/recurrenceLabel';
import { getLocale, translate } from './index';
import type { Locale, MessageKey } from './types';

function resolveParam(param: MessageParam, locale: Locale): string | number {
  if (typeof param === 'string' || typeof param === 'number') return param;
  if (Array.isArray(param)) return (param as readonly MessageParam[]).map((p) => resolveParam(p, locale)).join(', ');
  return formatMessageRef(param as MessageRef, locale);
}

/** Résout une référence de message du domaine (récursivement) dans la langue donnée (courante par défaut). */
export function formatMessageRef(ref: MessageRef, locale: Locale = getLocale()): string {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(ref.params ?? {})) params[name] = resolveParam(value, locale);
  return (translate as (l: Locale, k: MessageKey, p: Record<string, string | number>) => string)(
    locale,
    ref.key as MessageKey,
    params,
  );
}
