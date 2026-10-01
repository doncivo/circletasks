import { describe, expect, it } from 'vitest';
import { createUuidGenerator, uuidGenerator, uuidV4FromBytes } from './id';
import { isId } from './types';

describe('génération d’UUID', () => {
  it('produit des UUID v4 valides et distincts', () => {
    const a = uuidGenerator.next();
    const b = uuidGenerator.next();
    expect(isId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('est déterministe avec une source injectée', () => {
    const gen = createUuidGenerator((n) => new Uint8Array(n).fill(0xff));
    const id = gen.next();
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(isId(id)).toBe(true);
  });

  it('pose les bits de version et de variante', () => {
    expect(uuidV4FromBytes(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('refuse une longueur incorrecte', () => {
    expect(() => uuidV4FromBytes(new Uint8Array(8))).toThrow(RangeError);
  });

  it('se replie sur getRandomValues', () => {
    const gen = createUuidGenerator((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
    expect(isId(gen.next())).toBe(true);
  });
});
