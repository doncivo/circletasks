import type { Id } from './types';

/** Générateur d'identifiants injectable (déterministe en test). */
export interface IdGenerator {
  next(): Id;
}

/** Source d'octets aléatoires (Web Crypto en production, déterministe en test). */
export type RandomBytes = (length: number) => Uint8Array;

const webCryptoBytes: RandomBytes = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));

/**
 * UUID RFC 9562 de version 4 (aléatoire) ou 5 (par nom, `occurrenceId.ts`) à partir de 16 octets : bits de version et de variante posés.
 * Exporté pour les tests ; le code applicatif utilise `uuidGenerator`.
 */
export function uuidFromBytes(bytes: Uint8Array, version: 4 | 5): Id {
  if (bytes.length !== 16) throw new RangeError('UUID : 16 octets attendus');
  const b = Uint8Array.from(bytes);
  b[6] = ((b[6] ?? 0) & 0x0f) | (version << 4);
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variante RFC
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id;
}

export const uuidV4FromBytes = (bytes: Uint8Array): Id => uuidFromBytes(bytes, 4);

/**
 * Crée un générateur d'UUID v4. Utilise `crypto.randomUUID` (WebView2, WKWebView
 * iOS 15.4+, Node 19+) et se replie sur `getRandomValues` sinon.
 */
export function createUuidGenerator(random?: RandomBytes): IdGenerator {
  if (!random && typeof globalThis.crypto?.randomUUID === 'function') {
    return { next: () => globalThis.crypto.randomUUID() as Id };
  }
  const source = random ?? webCryptoBytes;
  return { next: () => uuidV4FromBytes(source(16)) };
}

export const uuidGenerator: IdGenerator = createUuidGenerator();

/** Nouvel identifiant typé d'entité : `newEntityId<TaskId>(ids)` (ADR 0004). */
export function newEntityId<T extends Id>(ids: IdGenerator): T {
  return ids.next() as T;
}
