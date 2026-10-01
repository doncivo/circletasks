import type { fr } from './fr';

type Source = typeof fr;

/** Même arborescence que fr.ts, valeurs libres : forme imposée aux autres langues. */
type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };
export type Messages = Shape<Source>;

/** Clés à points, ex. 'app.name'. */
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<Source>;

type ValueAt<T, K extends string> = K extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? ValueAt<T[H], R>
    : never
  : K extends keyof T
    ? T[K]
    : never;

type ParamNames<S> = S extends `${string}{${infer P}}${infer R}` ? P | ParamNames<R> : never;

export type MessageParams<K extends MessageKey> = Record<ParamNames<ValueAt<Source, K>>, string | number>;

/** Arguments de t() : paramètres obligatoires si le texte français en contient. */
export type TArgs<K extends MessageKey> = [ParamNames<ValueAt<Source, K>>] extends [never]
  ? []
  : [params: MessageParams<K>];

/**
 * Clés sans paramètre : utilisables dans des tables de configuration (onglets,
 * raccourcis, messages d'annulation) puis passées telles quelles à t().
 */
export type PlainMessageKey = { [K in MessageKey]: TArgs<K> extends [] ? K : never }[MessageKey];

export type Locale = 'fr' | 'en';
